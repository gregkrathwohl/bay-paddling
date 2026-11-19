// Animated surface currents from NOAA SFBOFS (scripts/fetch-currents.py).
// A living background: streaks drifting with the water. Strength shows as motion
// (faster, longer streaks). The data comes from a field (src/currents.js).
//
// The streaks are drawn *in the map*: a canvas that covers the current view (plus a
// margin) at screen resolution, given to MapLibre as a canvas source + raster layer.
// So it sits in the style's stacking order (under labels and buoys), stays crisp, and
// moves with the map while panning; after each pan/zoom it re-fits to the new view.
// Particles live in lng/lat and move at a fixed multiple of the real current.

const FPS = 30;
const MARGIN = 0.1;      // canvas reaches 10% beyond the view on each side
// every look-and-feel knob in one place; the tuning panel edits these live
export const DEFAULTS = {
  // tuned by Greg 2026-11-17 (v4): fine, opaque streaks with longer trails, on slightly toned water
  density: 3,       // particles per 1000 px² of screen at zoom 13.5
  zoomedOut: 0.3,    // how fast density thins as you zoom out (0 = no thinning)
  zoomOutSpeed: 0.8, // below zoom 13.5, keep streaks moving on screen (0 = real speed, 1 = same pixels/s as at 13.5)
  speed: 380,       // streaks move this many times faster than the water
  zoomEase: 0.85,   // past zoom 13.5, how much to damp the real-speed increase (0 = none, 1 = constant on screen)
  compress: 0.65,   // visual speed ∝ speed^compress (lower = slow water moves more)
  trail: 0.915,     // per-frame trail fade (higher = longer streaks)
  opacity: 2,       // overall streak opacity (multiplier; capped at fully opaque)
  width: 0.6,       // overall streak width (multiplier)
  life: 80,         // average particle life in frames (too long and particles bunch into 'tide lines')
  colour: '#ffffff', // streak colour
  calm: 0.3,        // share of streaks kept in slack water (1 = as many as in the channels)
};

// the viewer's "Currents" setting: Fine = the sparse white wind-map look above; Dense = many slow,
// translucent streaks that read as moving water (tuned by Greg 2026-11-19). Colour follows the map style.
export const PRESETS = {
  fine: () => ({}),
  dense: (theme) => ({ density: 25.5, zoomedOut: 0.1, speed: 220, trail: 0.925, width: 0.7, calm: 0.6,
    ...(theme === 'dark' ? { colour: '#a9d3f0', opacity: 0.35 } : { colour: '#1f4f7a', opacity: 0.45 }) }),
};

export class FlowLayer {
  constructor(map, data, { onTime, beforeId, isWater, params } = {}) {
    Object.assign(this, { map, data, onTime, beforeId, isWater });
    this.p = { ...DEFAULTS, ...(params || {}) };
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.t = this.nowIndex();
    this.visible = true;
    this.fit();
    this.attach();
    map.on('style.load', () => this.attach());
    map.on('moveend', () => { this.fit(); this.map.getSource('flow')?.setCoordinates(this.coords); });
    map.on('resize', () => { this.fit(); this.map.getSource('flow')?.setCoordinates(this.coords); });
  }

  attach() {
    const { map } = this;
    if (!map.getStyle() || map.getSource('flow')) return;
    map.addSource('flow', { type: 'canvas', canvas: this.canvas, coordinates: this.coords, animate: true });
    map.addLayer({ id: 'flow', type: 'raster', source: 'flow',
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      map.getLayer(this.beforeId) ? this.beforeId : undefined);
  }

  // re-fit the canvas to the view (in Web Mercator, so lng/lat → pixel is linear in x and in mercator-y)
  fit() {
    const c = this.map.getContainer(), W = c.clientWidth, H = c.clientHeight;
    const mW = W * MARGIN, mH = H * MARGIN;
    // screen resolution, but keep the texture re-uploaded every frame under ~4 MP
    const r = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4e6 / ((W + 2 * mW) * (H + 2 * mH))));
    const tl = this.map.unproject([-mW, -mH]), br = this.map.unproject([W + mW, H + mH]);
    this.west = tl.lng; this.east = br.lng; this.north = tl.lat; this.south = br.lat;
    const prev = this.CW ? { img: this.snapshot(), west: this.westOld, east: this.eastOld, my0: this.my0, my1: this.my1 } : null;
    this.CW = Math.round((W + 2 * mW) * r); this.CH = Math.round((H + 2 * mH) * r);
    this.canvas.width = this.CW; this.canvas.height = this.CH;
    this.pxScale = r;
    this.coords = [[this.west, this.north], [this.east, this.north], [this.east, this.south], [this.west, this.south]];
    this.my0 = this.mercY(this.north); this.my1 = this.mercY(this.south);
    const latMid = (this.north + this.south) / 2;
    this.mPerPx = ((this.east - this.west) * 111320 * Math.cos(latMid * Math.PI / 180)) / this.CW;
    this.westOld = this.west; this.eastOld = this.east;
    // carry the existing trails over (mercator is linear, so it's one drawImage)
    if (prev) {
      const x0 = ((prev.west - this.west) / (this.east - this.west)) * this.CW, x1 = ((prev.east - this.west) / (this.east - this.west)) * this.CW;
      const y0 = ((this.my0 - prev.my0) / (this.my0 - this.my1)) * this.CH, y1 = ((this.my0 - prev.my1) / (this.my0 - this.my1)) * this.CH;
      this.ctx.drawImage(prev.img, x0, y0, x1 - x0, y1 - y0);
    }
    // keep particles that are still in view, top up the rest
    const z = this.map.getZoom(), thin = z < 13.5 ? Math.pow(2, (z - 13.5) * this.p.zoomedOut) : 1;
    const count = Math.round(((W * H) / 1000) * this.p.density * thin * this.strengthK().density);
    this.data.view?.(this, this.mPerPx * r, this.t);   // metres per CSS pixel
    const keep = (this.parts || []).filter(p => p.lng > this.west && p.lng < this.east && p.lat > this.south && p.lat < this.north);
    this.parts = keep.slice(0, count).concat(Array.from({ length: Math.max(0, count - keep.length) }, () => this.spawn(true)));
  }
  // the viewer's single "Currents" slider (0–1, 0.5 = as tuned): more and brighter streaks, or fewer and fainter
  strengthK() { const s = this.strength ?? 0.5; return { density: Math.pow(2, (s - 0.5) * 2.4), opacity: Math.pow(2, (s - 0.5) * 1.2) }; }
  setStrength(s) { this.strength = s; this.fit(); }
  snapshot() { const c = document.createElement('canvas'); c.width = this.canvas.width; c.height = this.canvas.height; c.getContext('2d').drawImage(this.canvas, 0, 0); return c; }
  mercY(lat) { const r = lat * Math.PI / 180; return Math.log(Math.tan(Math.PI / 4 + r / 2)); }
  toPx(lng, lat) {
    return [((lng - this.west) / (this.east - this.west)) * this.CW, ((this.my0 - this.mercY(lat)) / (this.my0 - this.my1)) * this.CH];
  }

  nowIndex() {
    const now = Date.now(), ts = this.data.times.map(t => Date.parse(t));
    let best = 0;
    ts.forEach((t, i) => { if (Math.abs(t - now) < Math.abs(ts[best] - now)) best = i; });
    return best;
  }

  // velocity (m/s) at lng/lat, or null over land / while its tile is loading
  vel(lng, lat) {
    const v = this.data.sample(this.t, lng, lat);
    // exact water mask from our own coastline grid: streaks never cross land
    if (!v || (this.isWater && !this.isWater(lng, lat))) return null;
    return v;
  }

  spawn(randomAge = false) {
    for (let tries = 0; tries < 12; tries++) {
      const lng = this.west + Math.random() * (this.east - this.west);
      const lat = this.south + Math.random() * (this.north - this.south);
      const v = this.vel(lng, lat);
      if (!v) continue;
      // slack water gets fewer particles (it reads as clutter, not flow)
      const calm = this.p.calm ?? 0.3;
      if (Math.random() > calm + (1 - calm) * Math.min(1, Math.hypot(v[0], v[1]) / 0.35)) continue;
      const life = Math.round(this.p.life * (0.65 + 0.7 * Math.random()));
      return { lng, lat, age: randomAge ? (Math.random() * life) | 0 : 0, life };
    }
    return { lng: 0, lat: 0, age: 999, life: 0 }; // over land: retry next frame
  }

  step() {
    const ctx = this.ctx, r = this.pxScale;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${this.p.trail})`;
    ctx.fillRect(0, 0, this.CW, this.CH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt'; // round caps overlap at every joint and make beads
    // real-speed motion, but eased once you zoom in past 13.5 so it doesn't go to warp speed
    const z = this.map.getZoom();
    const mPerFrame = (this.p.speed / FPS) * (z > 13.5 ? Math.pow(2, -(z - 13.5) * this.p.zoomEase) : Math.pow(2, (13.5 - z) * this.p.zoomOutSpeed));
    const K = this.strengthK().opacity, hex = this.p.colour || '#ffffff';
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');
    // segments go into a few opacity × width buckets and each bucket is one stroke: far cheaper than a
    // stroke per streak (thousands a frame when dense)
    const NA = 12, NW = 4, buckets = this.buckets ||= Array.from({ length: NA * NW }, () => []);
    for (const b of buckets) b.length = 0;
    const cosLat = Math.cos(((this.north + this.south) / 2) * Math.PI / 180), W0 = this.west, X = this.CW / (this.east - this.west);
    const my0 = this.my0, Y = this.CH / (this.my0 - this.my1), merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    for (const p of this.parts) {
      const vel = p.age <= p.life && this.vel(p.lng, p.lat);
      if (!vel) { Object.assign(p, this.spawn()); continue; }
      p.age++;
      const sp = Math.hypot(vel[0], vel[1]);
      // visual speed ∝ speed^compress: slow shallows still drift visibly, channels stay clearly faster
      const vis = sp > 1e-4 ? (1.2 * Math.pow(sp / 1.2, this.p.compress)) / sp : 0;
      const dE = vel[0] * vis * mPerFrame, dN = vel[1] * vis * mPerFrame;
      const lng2 = p.lng + dE / (111320 * cosLat), lat2 = p.lat + dN / 110540;
      const life = Math.min(1, p.age / 8, (p.life - p.age) / 8);
      const strength = Math.min(1, Math.sqrt(sp / 1.2));
      const a = Math.min(1, life * (0.65 + 0.35 * strength) * this.p.opacity * K);
      const ai = Math.min(NA - 1, Math.round(a * (NA - 1))), wi = Math.min(NW - 1, Math.floor(strength * NW));
      if (ai > 0) buckets[ai * NW + wi].push((p.lng - W0) * X, (my0 - merc(p.lat)) * Y, (lng2 - W0) * X, (my0 - merc(lat2)) * Y);
      p.lng = lng2; p.lat = lat2;
    }
    for (let ai = 1; ai < NA; ai++) for (let wi = 0; wi < NW; wi++) {
      const seg = buckets[ai * NW + wi]; if (!seg.length) continue;
      ctx.strokeStyle = `rgba(${rgb},${(ai / (NA - 1)).toFixed(3)})`;
      ctx.lineWidth = (1.1 + 0.7 * ((wi + 0.5) / NW)) * r * this.p.width;
      ctx.beginPath();
      for (let k = 0; k < seg.length; k += 4) { ctx.moveTo(seg[k], seg[k + 1]); ctx.lineTo(seg[k + 2], seg[k + 3]); }
      ctx.stroke();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = 0;
    const loop = (ts) => {
      if (!this.running) return;
      if (ts - last >= 1000 / FPS) { this.step(); last = ts; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  setTime(t) {
    this.t = t; this.onTime?.(t);
    if (this.CW) this.data.view?.(this, this.mPerPx * this.pxScale, t);
  }
  setParams(patch) { Object.assign(this.p, patch); if ('density' in patch || 'zoomedOut' in patch || 'life' in patch) this.fit(); }

  setVisible(on) {
    this.visible = on;
    if (this.map.getLayer('flow')) this.map.setLayoutProperty('flow', 'visibility', on ? 'visible' : 'none');
    if (on) this.start(); else this.stop();
  }
}

export function timeLabel(data, t) {
  // the exact time between the hourly frames (live mode and playback move smoothly), to 5 minutes
  const i = Math.round(t), d = new Date(Math.round((Date.parse(data.times[0]) + t * 3600e3) / 300e3) * 300e3);
  const s = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `<b>${s}</b><small>${i < data.nowcast ? 'model nowcast' : 'NOAA forecast'}</small>`;
}
