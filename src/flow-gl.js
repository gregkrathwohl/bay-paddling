// Animated currents on the GPU (WebGL2): the same streaks as flow.js, but every particle is moved and
// drawn by the graphics chip in parallel, so it can afford 10–50× more of them.
//
// How it works (the classic "webgl-wind" technique, adapted to tiles and tides):
//
//   1. CURRENT TEXTURES  The current tiles in view (src/currents.js) are copied into one float texture
//      per hour: each pixel = (east m/s, north m/s, water 0/1). Two hours are bound at once and mixed
//      in the shader, so time moves smoothly between NOAA's hourly frames.
//   2. PARTICLE STATE    Every particle is one pixel of a float texture: (x, y, age, life), with x, y in
//      metres east/south of the grid's NW corner. An "update" shader reads a particle's pixel, looks up
//      the current under it, moves it, and writes the new state into a second texture (ping-pong).
//      Particles that die, leave the view or hit land respawn at a random spot in view.
//   3. TRAILS            The streaks live in a screen-sized texture. Each frame it is redrawn slightly
//      faded (that fade IS the tail), then every particle draws one short segment from its old to its
//      new position, as a thin quad. When the map pans or zooms, the old trail image is drawn at its old
//      place in the new view, so tails follow the water instead of the screen.
//   4. COMPOSITE         The trail texture is drawn over the map, under roads and labels (a MapLibre
//      custom layer slotted into the style like any other layer).
//
// Use: ?gl on the page. The tuner's knobs mean the same as in flow.js.
import { DEFAULTS } from './flow.js';

const MERC = `
  // metres from the grid's NW corner → Web Mercator 0..1 (what MapLibre's matrix expects)
  uniform vec4 u_grid;          // west lng, north lat, metres per degree lng, metres per degree lat
  vec2 toMerc(vec2 m) {
    float lng = u_grid.x + m.x / u_grid.z, lat = u_grid.y - m.y / u_grid.w;
    float s = sin(radians(lat));
    return vec2((lng + 180.0) / 360.0, 0.5 - log((1.0 + s) / (1.0 - s)) / (4.0 * 3.14159265));
  }`;

const LAND = `
  // our own coastline (12 m route grid): 1 = water, 0 = land. Without it (u_hasLand = 0) all is water.
  uniform sampler2D u_land;
  uniform vec4 u_landRect;      // origin x, y and size w, h, in metres
  uniform float u_hasLand;
  float water(vec2 m) {
    if (u_hasLand < 0.5) return 1.0;
    vec2 uv = (m - u_landRect.xy) / u_landRect.zw;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
    return texture(u_land, uv).r;
  }`;

const CURRENT = `
  // the current at a point (metres), mixed between hour t0 and t1. .xy = m/s east/north, .z = water
  uniform sampler2D u_cur0, u_cur1;
  uniform vec4 u_mosaic;        // mosaic origin x, y (metres) and size w, h (metres)
  uniform float u_ft;           // 0..1 between the two hours
  vec3 current(vec2 m) {
    vec2 uv = (m - u_mosaic.xy) / u_mosaic.zw;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
    return mix(texture(u_cur0, uv).xyz, texture(u_cur1, uv).xyz, u_ft);
  }`;

// ---- 2. update: one fragment = one particle
const UPDATE_VS = `#version 300 es
  void main() { vec2 p = vec2((gl_VertexID & 1) * 2 - 1, (gl_VertexID >> 1) * 2 - 1); gl_Position = vec4(p, 0, 1); }`;
const UPDATE_FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_state;
  uniform vec4 u_view;          // the view in metres: x0, y0, x1, y1 (where particles respawn)
  uniform float u_step, u_compress, u_life, u_calm, u_dage;   // u_dage: age gained this frame (1 = one 30 fps frame)
  uniform uint u_frame;
  ${CURRENT}
  ${LAND}
  out vec4 o;
  // random numbers: a PCG integer hash, seeded per particle and per frame. (The common
  // fract(sin(dot(...))) one-liner is correlated between neighbouring pixels and drops new particles
  // onto a faint lattice, which shows up as a grid in slow water.)
  uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
  uint rng;
  float rand() { rng = pcg(rng); return float(rng) / 4294967295.0; }
  vec4 spawn() {
    // up to 8 tries at a random spot in view; slack water is accepted less often (u_calm)
    for (int i = 0; i < 8; i++) {
      vec2 m = mix(u_view.xy, u_view.zw, vec2(rand(), rand()));
      vec3 c = current(m);
      float keep = u_calm + (1.0 - u_calm) * min(1.0, length(c.xy) / 0.35);
      if (c.z > 0.5 && water(m) > 0.5 && rand() < keep) {
        float life = u_life * (0.65 + 0.7 * rand());
        return vec4(m, -rand() * life, life);   // negative age = staggered start (no fade-in wave)
      }
    }
    return vec4(-1e6, -1e6, 1e6, 0.0);   // no water found: stay dead, try again next frame
  }
  void main() {
    vec4 p = texelFetch(u_state, ivec2(gl_FragCoord.xy), 0);
    rng = pcg(uint(gl_FragCoord.x) + pcg(uint(gl_FragCoord.y) + pcg(u_frame)));
    vec3 c = current(p.xy);
    bool outside = any(lessThan(p.xy, u_view.xy)) || any(greaterThan(p.xy, u_view.zw));
    if (p.z > p.w || c.z < 0.5 || outside || water(p.xy) < 0.5) { o = spawn(); return; }
    // visual speed ∝ speed^compress (slow water still drifts visibly), north is −y
    float sp = length(c.xy);
    float vis = sp > 1e-4 ? 1.2 * pow(sp / 1.2, u_compress) / sp : 0.0;
    o = vec4(p.xy + vec2(c.x, -c.y) * vis * u_step, p.z + u_dage, p.w);
  }`;

// ---- 3a. draw: six vertices (two triangles) per particle, from its old to its new position
const DRAW_VS = `#version 300 es
  precision highp float;
  uniform sampler2D u_old, u_new;
  uniform int u_side;           // the state textures are u_side × u_side
  uniform mat4 u_matrix;
  uniform vec2 u_px;            // drawing-buffer size, for line width in pixels
  uniform float u_width, u_opacity;
  ${MERC}
  ${CURRENT}
  out float v_alpha;
  out vec2 v_m;                 // metres, for clipping at the shore
  void main() {
    int id = gl_VertexID / 6, corner = gl_VertexID % 6;
    ivec2 t = ivec2(id % u_side, id / u_side);
    vec4 a = texelFetch(u_old, t, 0), b = texelFetch(u_new, t, 0);
    // just respawned (its age went down) or not started yet (negative age): draw nothing
    if (b.z <= 0.0 || b.z < a.z) { gl_Position = vec4(2, 2, 2, 1); v_alpha = 0.0; return; }
    vec4 pa = u_matrix * vec4(toMerc(a.xy), 0, 1), pb = u_matrix * vec4(toMerc(b.xy), 0, 1);
    vec2 sa = pa.xy / pa.w * u_px * 0.5, sb = pb.xy / pb.w * u_px * 0.5;
    float strength = min(1.0, sqrt(length(current(b.xy).xy) / 1.2));
    // lines thinner than a pixel alias (moiré, "static" while panning): draw them 1 px wide and fainter instead
    float w0 = (1.1 + 0.7 * strength) * u_width, w = max(w0, 1.0), cover = w0 / w;
    vec2 d = sb - sa; float len = length(d);
    vec2 n = len > 1e-4 ? vec2(-d.y, d.x) / len * w * 0.5 : vec2(0.0);
    // corners: 0,1,2 / 2,1,3 → (a−n, a+n, b−n) / (b−n, a+n, b+n)
    bool atB = corner == 2 || corner == 3 || corner == 5;
    bool plus = corner == 1 || corner == 4 || corner == 5;
    vec2 s = (atB ? sb : sa) + (plus ? n : -n);
    v_m = atB ? b.xy : a.xy;
    gl_Position = vec4(s / (u_px * 0.5) * (atB ? pb.w : pa.w), 0, atB ? pb.w : pa.w);
    float life = min(1.0, min(b.z / 8.0, (b.w - b.z) / 8.0));
    v_alpha = clamp(life * (0.65 + 0.35 * strength) * u_opacity * cover, 0.0, 1.0);
  }`;
const DRAW_FS = `#version 300 es
  precision highp float;
  uniform vec3 u_colour;
  ${LAND}
  in float v_alpha;
  in vec2 v_m;
  out vec4 o;
  void main() {
    float w = water(v_m);
    if (w < 0.5) discard;                                  // never draw over land
    o = vec4(u_colour * v_alpha, v_alpha);                 // premultiplied alpha
  }
  `;

// ---- 3b / 4. a textured quad: the previous trails (faded, at their old place) or the final composite
const QUAD_VS = `#version 300 es
  uniform mat4 u_matrix;
  uniform vec4 u_rect;          // mercator x0, y0, x1, y1 (identity matrix + −1..1 rect for full screen)
  out vec2 v_uv;
  void main() {
    vec2 c = vec2(gl_VertexID & 1, gl_VertexID >> 1);
    v_uv = vec2(c.x, 1.0 - c.y);
    gl_Position = u_matrix * vec4(mix(u_rect.xy, u_rect.zw, c), 0, 1);
  }`;
const QUAD_FS = `#version 300 es
  precision mediump float;
  uniform sampler2D u_tex;
  uniform float u_fade;
  in vec2 v_uv;
  out vec4 o;
  void main() { o = texture(u_tex, v_uv) * u_fade; }`;

function program(gl, vs, fs) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class FlowGL {
  constructor(map, data, { onTime, beforeId, params, router } = {}) {
    Object.assign(this, { map, data, onTime, beforeId, router });
    this.p = { ...DEFAULTS, ...(params || {}) };
    this.t = this.nowIndex();
    this.visible = true;
    this.strength = 0.5;
    this.count = 0;
    this.stats = { frames: 0, ms: 0 };
    const self = this;
    this.layer = { id: 'flow', type: 'custom', renderingMode: '2d',
      onAdd(m, gl) { self.init(gl); },
      prerender(gl, args) { self.prerender(gl, args); },
      render(gl, args) { self.composite(gl, args); } };
    this.attach();
    map.on('style.load', () => this.attach());
    map.on('moveend', () => this.view());
    map.on('move', () => this.view(true));
    map.on('movestart', () => { this.moving = true; }); map.on('moveend', () => { this.moving = false; });
    this.view();
  }
  attach() { if (this.map.getStyle() && !this.map.getLayer('flow')) this.map.addLayer(this.layer, this.map.getLayer(this.beforeId) ? this.beforeId : undefined); }

  init(gl) {
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) console.warn('FlowGL: no float render targets');
    this.update = program(gl, UPDATE_VS, UPDATE_FS);
    this.draw = program(gl, DRAW_VS, DRAW_FS);
    this.quad = program(gl, QUAD_VS, QUAD_FS);
    this.vao = gl.createVertexArray();
    this.fb = gl.createFramebuffer();
    this.cur = [gl.createTexture(), gl.createTexture()];
    this.land = gl.createTexture(); this.landKey = null;
    this.curKey = [null, null];
    this.state = [null, null]; this.trail = [null, null]; this.trailRect = null; this.side = 0; this.trailW = 0;
  }

  // ---- textures
  tex(w, h, internal, format, type, data = null, filter = this.gl.NEAREST) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // particle count from the view size and the density knobs (same rule as flow.js)
  wantCount() {
    const c = this.map.getContainer(), z = this.map.getZoom();
    const thin = z < 13.5 ? Math.pow(2, (z - 13.5) * this.p.zoomedOut) : 1, k = this.strengthK().density;
    // phones get at most 200k (their GPUs and batteries); big screens at most 1.5 million
    const cap = innerWidth <= 700 ? 2e5 : 1.5e6;
    return Math.max(1, Math.min(cap, Math.round(((c.clientWidth * c.clientHeight) / 1000) * this.p.density * thin * k)));
  }
  ensureState() {
    const gl = this.gl, n = this.wantCount(), side = Math.ceil(Math.sqrt(n));
    if (side === this.side) return;
    this.side = side; this.count = side * side;
    // everyone starts dead (age > life) so the first update spawns them all in view
    const init = new Float32Array(side * side * 4); for (let i = 0; i < side * side; i++) { init[i * 4 + 2] = 1; init[i * 4 + 3] = 0; }
    for (let k = 0; k < 2; k++) { if (this.state[k]) gl.deleteTexture(this.state[k]); this.state[k] = this.tex(side, side, gl.RGBA32F, gl.RGBA, gl.FLOAT, init); }
  }
  ensureTrails(w, h) {
    const gl = this.gl;
    if (this.trailW === w && this.trailH === h) return;
    this.trailW = w; this.trailH = h; this.trailRect = null;
    for (let k = 0; k < 2; k++) { if (this.trail[k]) gl.deleteTexture(this.trail[k]); this.trail[k] = this.tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR); }
  }

  // ---- the view in grid metres, the tile level, and which tiles to fetch
  view(onlyRect = false) {
    const m = this.map, c = m.getContainer(), g = this.data.grid;
    const tl = m.unproject([-0.1 * c.clientWidth, -0.1 * c.clientHeight]), br = m.unproject([1.1 * c.clientWidth, 1.1 * c.clientHeight]);
    const mPerPx = ((br.lng - tl.lng) * g.mx) / (1.2 * c.clientWidth);
    if (!onlyRect) this.data.view({ west: tl.lng, east: br.lng, north: tl.lat, south: br.lat }, mPerPx, this.t);
    this.viewM = [(tl.lng - g.w) * g.mx, (g.n - tl.lat) * g.my, (br.lng - g.w) * g.mx, (g.n - br.lat) * g.my];
  }
  // (re)build the two hour textures when the view, the hour or the loaded tiles change
  refreshCurrents() {
    const gl = this.gl, d = this.data, g = d.grid, z = d.level, cell = g.cell * (1 << (g.maxzoom - z)), S = g.tile, n = 1 << z;
    const [x0, y0, x1, y1] = this.viewM, tsz = S * cell;
    const tx0 = Math.max(0, Math.floor(x0 / tsz)), ty0 = Math.max(0, Math.floor(y0 / tsz));
    const tx1 = Math.min(n - 1, Math.floor(x1 / tsz)), ty1 = Math.min(n - 1, Math.floor(y1 / tsz));
    const t0 = Math.floor(this.t), t1 = Math.min(d.times.length - 1, t0 + 1);
    [t0, t1].forEach((h, k) => {
      const key = `${h}/${z}/${tx0}/${ty0}/${tx1}/${ty1}`;
      if (this.curKey[k] === key) return;
      const mo = d.mosaic(h, z, tx0, ty0, tx1 - tx0 + 1, ty1 - ty0 + 1);
      gl.bindTexture(gl.TEXTURE_2D, this.cur[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, mo.width, mo.height, 0, gl.RGBA, gl.FLOAT, mo.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.curKey[k] = mo.complete ? key : null;   // incomplete: rebuild when more tiles arrive
    });
    this.mosaicM = [tx0 * tsz, ty0 * tsz, (tx1 - tx0 + 1) * tsz, (ty1 - ty0 + 1) * tsz];
    // the land mask for the view: 12 m cells when zoomed in, 48 m across the whole Bay
    const R = this.router;
    if (R?.loaded) {
      const lz = (x1 - x0) < 25000 ? R.meta.fine : R.meta.coarse, lcell = R.levels[lz].cell, ltsz = R.T * lcell, ln = 1 << lz;
      const lx0 = Math.max(0, Math.floor(x0 / ltsz)), ly0 = Math.max(0, Math.floor(y0 / ltsz));
      const lx1 = Math.min(ln - 1, Math.floor(x1 / ltsz)), ly1 = Math.min(ln - 1, Math.floor(y1 / ltsz));
      const lkey = `${lz}/${lx0}/${ly0}/${lx1}/${ly1}`;
      if (lkey !== this.landKey) {
        const mk = R.mask(lz, lx0, ly0, lx1 - lx0 + 1, ly1 - ly0 + 1);
        gl.bindTexture(gl.TEXTURE_2D, this.land);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mk.width, mk.height, 0, gl.RED, gl.UNSIGNED_BYTE, mk.data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.landKey = lkey; this.landRect = [lx0 * ltsz, ly0 * ltsz, (lx1 - lx0 + 1) * ltsz, (ly1 - ly0 + 1) * ltsz];
      }
    }
    this.retry = performance.now();
  }
  bindCurrent(prog) {
    const gl = this.gl, g = this.data.grid;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.cur[0]);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.cur[1]);
    gl.uniform1i(prog.u.u_cur0, 1); gl.uniform1i(prog.u.u_cur1, 2);
    gl.uniform4fv(prog.u.u_mosaic, this.mosaicM);
    gl.uniform1f(prog.u.u_ft, this.t - Math.floor(this.t));
    if (prog.u.u_grid) gl.uniform4f(prog.u.u_grid, g.w, g.n, g.mx, g.my);
    if (prog.u.u_land) {
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.land); gl.uniform1i(prog.u.u_land, 4);
      gl.uniform4fv(prog.u.u_landRect, this.landRect || [0, 0, 1, 1]); gl.uniform1f(prog.u.u_hasLand, this.landKey ? 1 : 0);
    }
  }

  // ---- every frame, before MapLibre draws: move particles, fade + extend the trails (off screen)
  prerender(gl, args) {
    if (!this.visible || !this.viewM) return;
    const t0 = performance.now();
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), prevVp = gl.getParameter(gl.VIEWPORT);
    const now = performance.now(), dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 30; this.last = now;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, z = this.map.getZoom();
    this.ensureState(); this.ensureTrails(W, H);
    // rebuild the hour textures when the view or hour changed, or (every 0.3 s) while tiles are still arriving
    if (!this.landKey && this.router?.loaded) this.curKey = [null, null];   // the coastline just arrived
    if (!this.curKey.includes(null) || !this.retry || performance.now() - this.retry > 300) this.refreshCurrents();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);

    // 2. update particles: state[0] → state[1]
    const step = this.p.speed * dt * (z > 13.5 ? Math.pow(2, -(z - 13.5) * this.p.zoomEase) : Math.pow(2, (13.5 - z) * this.p.zoomOutSpeed));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.state[1], 0);
    gl.viewport(0, 0, this.side, this.side); gl.disable(gl.BLEND);
    let P = this.update; gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state[0]); gl.uniform1i(P.u.u_state, 0);
    this.bindCurrent(P);
    gl.uniform4fv(P.u.u_view, this.viewM);
    gl.uniform1f(P.u.u_step, step); gl.uniform1f(P.u.u_compress, this.p.compress); gl.uniform1ui(P.u.u_frame, (this.frame = ((this.frame || 0) + 1) >>> 0));
    gl.uniform1f(P.u.u_life, this.p.life); gl.uniform1f(P.u.u_calm, this.p.calm ?? 0.3); gl.uniform1f(P.u.u_dage, 30 * dt);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. trails: previous image, faded, at its old place → trail[1]; then this frame's segments on top
    const matrix = args.defaultProjectionData?.mainMatrix || args.modelViewProjectionMatrix;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trail[1], 0);
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const c = this.map.getContainer(), m0 = this.map.unproject([0, 0]), m1 = this.map.unproject([c.clientWidth, c.clientHeight]);
    const mx = (lng) => (lng + 180) / 360, my = (lat) => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
    const rect = [mx(m0.lng), my(m0.lat), mx(m1.lng), my(m1.lat)];   // NW, SE: same orientation as the screen
    if (this.trailRect) {
      P = this.quad; gl.useProgram(P.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.trail[0]); gl.uniform1i(P.u.u_tex, 0);
      // same view as last frame: a pixel-exact copy. Moved: draw last frame's image where it now belongs.
      const still = rect.every((v, i) => Math.abs(v - this.trailRect[i]) < 1e-12);
      gl.uniformMatrix4fv(P.u.u_matrix, false, still ? IDENTITY : matrix); gl.uniform4fv(P.u.u_rect, still ? [-1, 1, 1, -1] : this.trailRect);
      // shorter tails as the knob goes denser; while the map moves, old trails fade 3× faster so their edges don't linger
      gl.uniform1f(P.u.u_fade, Math.pow(1 - (1 - this.p.trail) * this.strengthK().tail, 30 * dt * (this.moving ? 3 : 1)));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    P = this.draw; gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state[0]); gl.uniform1i(P.u.u_old, 0);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.state[1]); gl.uniform1i(P.u.u_new, 3);
    this.bindCurrent(P);
    gl.uniform1i(P.u.u_side, this.side); gl.uniformMatrix4fv(P.u.u_matrix, false, matrix);
    gl.uniform2f(P.u.u_px, W, H); gl.uniform1f(P.u.u_width, this.p.width * devicePixelRatio * this.strengthK().width);
    gl.uniform1f(P.u.u_opacity, this.p.opacity * this.strengthK().opacity);
    const hex = this.p.colour || '#ffffff'; gl.uniform3f(P.u.u_colour, ...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
    gl.drawArrays(gl.TRIANGLES, 0, this.count * 6);

    // the trail image now covers the current screen: remember where that is
    this.trailRect = rect;
    this.state.reverse(); this.trail.reverse();
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb); gl.viewport(...prevVp);
    this.stats.frames++; this.stats.ms += performance.now() - t0;
    // frames per second, over the last second (shown in the lab's tuner)
    (this.ticks ||= []).push(now); while (this.ticks[0] < now - 1000) this.ticks.shift();
    this.fps = this.ticks.length;
  }
  // ---- MapLibre's pass: lay the trail image over the map
  composite(gl) {
    if (!this.visible || !this.trailRect) return;
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    const P = this.quad; gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.trail[0]); gl.uniform1i(P.u.u_tex, 0);
    gl.uniformMatrix4fv(P.u.u_matrix, false, IDENTITY); gl.uniform4f(P.u.u_rect, -1, 1, 1, -1); gl.uniform1f(P.u.u_fade, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    if (this.visible) this.map.triggerRepaint();   // keep animating
  }

  // ---- the same small interface as FlowLayer
  nowIndex() {
    const now = Date.now(), ts = this.data.times.map(t => Date.parse(t));
    return ts.reduce((b, x, k) => (Math.abs(x - now) < Math.abs(ts[b] - now) ? k : b), 0);
  }
  setTime(t) {
    const hourChanged = Math.floor(t) !== Math.floor(this.t);
    this.t = t; this.onTime?.(t);
    if (hourChanged && this.viewM) this.view();   // fetch the next hours' tiles
  }
  setVisible(on) { this.visible = on; if (this.map.getLayer('flow')) this.map.setLayoutProperty('flow', 'visibility', on ? 'visible' : 'none'); this.map.triggerRepaint(); }
  setParams(patch) { Object.assign(this.p, patch); this.map.triggerRepaint(); }
  setStrength(s) { this.strength = s; }
  // the viewer's one "Streaks" knob, 0..1 (0.5 = as tuned). Towards 0: fewer streaks, but longer, wider and
  // bolder, so the water still reads; towards 1: many more, shorter, finer and fainter.
  strengthK() {
    const d = this.strength - 0.5;
    return { density: Math.pow(2, d * 3), opacity: Math.pow(2, -d * 0.8), width: Math.pow(2, -d * 0.8), tail: Math.pow(2, d * 1.6) };
  }
  start() {} stop() {}
  get parts() { return { length: this.count }; }
  vel(lng, lat) { return this.data.sample(this.t, lng, lat); }
}
