// Land-avoiding router for big areas (the whole Bay), on the tiled grid from scripts/navgrid.py.
//
// navgrid.pmtiles holds distance-to-shore at two levels: 12 m cells (fine) and 48 m (coarse).
// The archive is small (< 1 MB, land tiles are left out), so it's fetched once, in one request,
// the first time a route is planned.
//
// A leg is found in two passes:
//   1. Lazy Theta* (any-angle A*) on the coarse grid: fast across the whole Bay. A coarse cell is
//      open if any water under it is ≥ buffer from shore, so narrow channels stay connected; that
//      path can clip a point or a breakwater, which the next step fixes.
//   2. On the fine grid: follow the coarse path, searching the fine grid wherever a step isn't a
//      clear line, then pull it tight (drop turns you don't need, slide the rest toward the shore)
//      so it wraps points as closely as the buffer allows.
// Distances in the archive are in 12 m units at both levels.
import { PMTiles } from 'pmtiles';

// a PMTiles source over bytes already in memory
class BufferSource {
  constructor(buf, key) { this.buf = buf; this.key = key; }
  getKey() { return this.key; }
  async getBytes(offset, length) { return { data: this.buf.slice(offset, offset + length) }; }
}

// Map/Set look-alikes over typed arrays (much faster for dense searches)
class FlatMap {
  constructor(n, T, empty) { this.a = new T(n).fill(empty); this.empty = empty; }
  get(i) { const v = this.a[i]; return v === this.empty ? undefined : v; }
  set(i, v) { this.a[i] = v; return this; }
  has(i) { return this.a[i] !== this.empty; }
}
class FlatSet {
  constructor(n) { this.a = new Uint8Array(n); this.size = 0; }
  has(i) { return this.a[i] === 1; }
  add(i) { if (!this.a[i]) { this.a[i] = 1; this.size++; } return this; }
}

export class TileRouter {
  static async load(base) {
    const meta = await fetch(`${base}/data/navgrid.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!meta?.fine) return null;
    return new TileRouter(meta, `${base}/data/navgrid.pmtiles`);
  }

  constructor(meta, url) {
    Object.assign(this, { meta, url });
    this.mx = 111320 * Math.cos(meta.lat0 * Math.PI / 180); this.my = 110540;
    [this.w, this.n] = meta.origin;
    this.T = meta.tile;
    this.levels = {};            // z → { N, cell, tiles: Map(ty·64 + tx → Uint8Array) }
    this.setBuffer(30);
    this.ready = null;
  }

  // fetch + decode every tile (once)
  load() {
    return (this.ready ||= (async () => {
      const buf = await fetch(this.url).then(r => r.arrayBuffer());
      const pm = new PMTiles(new BufferSource(buf, this.url));
      const { T, meta } = this, cv = new OffscreenCanvas(T, T), ctx = cv.getContext('2d', { willReadFrequently: true });
      for (const z of [meta.fine, meta.coarse]) {
        const N = T << z, cell = meta.cell * (1 << (meta.fine - z)), tiles = new Map(), n = 1 << z;
        const jobs = [];
        for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) jobs.push((async () => {
          const r = await pm.getZxy(z, tx, ty); if (!r?.data) return;
          const bmp = await createImageBitmap(new Blob([r.data], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
          tiles.set(ty * 64 + tx, bmp);
        })());
        await Promise.all(jobs);
        for (const [k, bmp] of tiles) {   // decode one at a time on the shared canvas
          ctx.clearRect(0, 0, T, T); ctx.drawImage(bmp, 0, 0);
          const px = ctx.getImageData(0, 0, T, T).data, a = new Uint8Array(T * T);
          for (let i = 0; i < a.length; i++) a[i] = px[i * 4];
          tiles.set(k, a);
        }
        this.levels[z] = { N, cell, tiles };
      }
      this.label();
    })());
  }
  get loaded() { return !!this.levels[this.meta.fine]; }

  // distance to shore in cells of level z (0 = land or outside)
  d(z, x, y) {
    const L = this.levels[z];
    if (!L || x < 0 || y < 0 || x >= L.N || y >= L.N) return 0;
    const t = L.tiles.get(((y / this.T) | 0) * 64 + ((x / this.T) | 0));
    return t ? t[(y % this.T) * this.T + (x % this.T)] : 0;
  }
  setBuffer(m) { this.buffer = m; if (this.loaded) this.label(); }

  // connected bodies of open water on the coarse level (4-connected flood fill), so a leg whose end
  // lands in a lagoon or salt pond can start from the main Bay instead of searching everything
  label() {
    const C = this.meta.coarse, N = this.levels[C].N, comp = new Int32Array(N * N), size = [0];
    const stack = new Int32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (comp[i] || !this.open(C, i % N, (i / N) | 0)) continue;
      const id = size.length; let top = 0, n = 0; stack[top++] = i; comp[i] = id;
      while (top) {
        const j = stack[--top], x = j % N, y = (j / N) | 0; n++;
        for (const [X, Y] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          const k = Y * N + X;
          if (X >= 0 && Y >= 0 && X < N && Y < N && !comp[k] && this.open(C, X, Y)) { comp[k] = id; stack[top++] = k; }
        }
      }
      size.push(n);
    }
    this.comp = comp; this.main = size.indexOf(Math.max(...size.slice(1)));
  }
  // nearest coarse cell in the main body of water
  snapMain([x, y]) {
    const C = this.meta.coarse, N = this.levels[C].N, inMain = (X, Y) => X >= 0 && Y >= 0 && X < N && Y < N && this.comp[Y * N + X] === this.main;
    if (inMain(x, y)) return [x, y];
    for (let r = 1; r < N; r++) for (let d = -r; d <= r; d++)
      for (const [X, Y] of [[x + d, y - r], [x + d, y + r], [x - r, y + d], [x + r, y + d]]) if (inMain(X, Y)) return [X, Y];
    return null;
  }
  open(z, x, y) { return this.d(z, x, y) * this.meta.cell >= this.buffer; }

  // lng/lat ↔ cell at level z
  toCell(z, [lon, lat]) { const c = this.levels[z].cell; return [Math.round(((lon - this.w) * this.mx) / c), Math.round(((this.n - lat) * this.my) / c)]; }
  toLL(z, [x, y]) { const c = this.levels[z].cell; return [this.w + (x * c) / this.mx, this.n - (y * c) / this.my]; }
  scale(from, to, [x, y]) { const k = this.levels[from].cell / this.levels[to].cell; return [x * k, y * k]; }

  // is this point water by our coastline? (unknown → yes, so streaks still show before the grid loads)
  isWater(lng, lat) {
    if (!this.loaded) return true;
    const [x, y] = this.toCell(this.meta.fine, [lng, lat]);
    return this.d(this.meta.fine, x, y) > 0;
  }

  // nearest open cell (beaches and launches sit on land; we paddle out from them)
  snap(z, [x, y]) {
    if (this.open(z, x, y)) return [x, y];
    for (let r = 1; r < 300; r++) {
      let best = null, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !this.open(z, x + dx, y + dy)) continue;
        const dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = [x + dx, y + dy]; }
      }
      if (best) return best;
    }
    return null;
  }

  // every cell on the straight line is open
  clear(z, [x0, y0], [x1, y1]) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let k = 0; k <= n; k++) if (!this.open(z, Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n))) return false;
    return true;
  }

  // Lazy Theta* on level z (sparse: only the cells it touches are stored)
  thetaStar(z, a, b, maxNodes = 2e6) {
    const N = this.levels[z].N, id = ([x, y]) => y * N + x, xy = (i) => [i % N, Math.floor(i / N)];
    const start = id(a), goal = id(b);
    // flat arrays when the level is small enough (coarse: 2048² cells), sparse maps for the fine one
    const flat = N * N <= 1 << 23;
    const g = flat ? new FlatMap(N * N, Float32Array, Infinity) : new Map(), par = flat ? new FlatMap(N * N, Int32Array, -1) : new Map();
    const done = flat ? new FlatSet(N * N) : new Set();
    const dist = (i, j) => { const [x1, y1] = xy(i), [x2, y2] = xy(j); return Math.hypot(x2 - x1, y2 - y1); };
    const heap = [];
    const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const nbrs = (i) => { const [x, y] = xy(i), out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && this.open(z, x + dx, y + dy)) out.push((y + dy) * N + x + dx);
      return out; };
    g.set(start, 0); par.set(start, start); push([dist(start, goal), start]);
    while (heap.length) {
      const [, s] = pop();
      if (done.has(s)) continue;
      if (par.get(s) !== s && !this.clear(z, xy(par.get(s)), xy(s))) {
        let best = Infinity;
        for (const n of nbrs(s)) if (done.has(n) && g.get(n) + dist(n, s) < best) { best = g.get(n) + dist(n, s); par.set(s, n); }
        g.set(s, best);
      }
      if (s === goal) break;
      done.add(s);
      if (done.size > maxNodes) return null;
      for (const n of nbrs(s)) {
        if (done.has(n)) continue;
        const p = par.get(s), ng = g.get(p) + dist(p, n);
        if (ng < (g.get(n) ?? Infinity)) { g.set(n, ng); par.set(n, p); push([ng + dist(n, goal), n]); }
      }
    }
    if (!par.has(goal)) return null;
    const path = [];
    for (let i = goal; ; i = par.get(i)) { path.push(xy(i)); if (i === start) break; }
    return path.reverse();
  }

  pull(z, path) {
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !this.clear(z, path[i], path[j])) j--;
      out.push(path[j]); i = j;
    }
    return out;
  }
  tighten(z, path, passes = 3) {
    for (let k = 0; k < passes; k++) {
      const out = [path[0]];
      for (let i = 1; i < path.length - 1; i++) {
        const a = out[out.length - 1], v = path[i], b = path[i + 1];
        let lo = 0, hi = 0.5;
        for (let it = 0; it < 12; it++) {
          const t = (lo + hi) / 2;
          const A = [v[0] + (a[0] - v[0]) * t, v[1] + (a[1] - v[1]) * t], B = [v[0] + (b[0] - v[0]) * t, v[1] + (b[1] - v[1]) * t];
          if (this.clear(z, A, B)) lo = t; else hi = t;
        }
        if (lo < 0.01) out.push(v);
        else out.push([v[0] + (a[0] - v[0]) * lo, v[1] + (a[1] - v[1]) * lo], [v[0] + (b[0] - v[0]) * lo, v[1] + (b[1] - v[1]) * lo]);
      }
      out.push(path[path.length - 1]);
      path = this.pull(z, out);
    }
    return path;
  }

  toWater(ll) {
    if (!this.loaded) return ll;
    const F = this.meta.fine, c = this.toCell(F, ll), s = this.snap(F, c);
    if (!s || (s[0] === c[0] && s[1] === c[1])) return ll;
    return this.toLL(F, s).map(v => +v.toFixed(5));
  }

  // one leg between two lng/lat points → lng/lat coordinates (straight line if no way is found)
  leg(a, b) {
    if (!this.loaded) return [a, b];
    const F = this.meta.fine, C = this.meta.coarse;
    const fa = this.snap(F, this.toCell(F, a)), fb = this.snap(F, this.toCell(F, b));
    if (!fa || !fb) return [a, b];
    let fine;
    if (this.clear(F, fa, fb)) fine = [fa, fb];
    else {
      // 1. coarse search between the coarse cells nearest the two ends
      let ca = this.snap(C, this.scale(F, C, fa).map(Math.round)), cb = this.snap(C, this.scale(F, C, fb).map(Math.round));
      // ends in different bodies of water (a lagoon, a pond): go via the main Bay
      if (ca && cb && this.comp[ca[1] * this.levels[C].N + ca[0]] !== this.comp[cb[1] * this.levels[C].N + cb[0]]) {
        ca = this.snapMain(ca); cb = this.snapMain(cb);
      }
      const coarse = ca && cb && this.thetaStar(C, ca, cb);
      if (coarse) {
        // 2. onto the fine grid: points every ~200 m along the coarse path (snapped to open water),
        //    joined by a short fine search wherever a step isn't a clear line
        const k = 1 << (F - C), mid = (k - 1) / 2, STEP = 4;   // coarse cells between points
        const pts = [fa];
        for (let i = 1; i < coarse.length; i++) {
          const [x0, y0] = coarse[i - 1], [x1, y1] = coarse[i], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
          for (let j = 1; j <= n; j++) {
            if (i === coarse.length - 1 && j === n) break;   // the last coarse cell is fb's
            const p = [Math.round((x0 + ((x1 - x0) * j) / n) * k + mid), Math.round((y0 + ((y1 - y0) * j) / n) * k + mid)];
            const q = this.snap(F, p); if (q) pts.push(q);
          }
        }
        pts.push(fb);
        fine = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const p = fine[fine.length - 1], q = pts[i];
          if (this.clear(F, p, q)) { fine.push(q); continue; }
          const sub = this.thetaStar(F, p, q, 5e4);
          if (sub) fine.push(...sub.slice(1)); else fine.push(q);
        }
      } else fine = this.thetaStar(F, fa, fb, 2e5);   // no coarse way: a short fine search, else give up
      if (!fine) return [a, b];
    }
    return [a, ...this.tighten(F, this.pull(F, fine)).map(c => this.toLL(F, c)), b];
  }
  resetVisited() {}

  // for the WebGL streaks: water (255) / land (0) for a block of tiles at level z, one byte per cell
  mask(z, tx0, ty0, ntx, nty) {
    const L = this.levels[z], T = this.T, W = ntx * T, out = new Uint8Array(W * nty * T);
    for (let j = 0; j < nty; j++) for (let i = 0; i < ntx; i++) {
      const t = L.tiles.get((ty0 + j) * 64 + tx0 + i); if (!t) continue;
      for (let y = 0; y < T; y++) { const o = (j * T + y) * W + i * T, k = y * T; for (let x = 0; x < T; x++) out[o + x] = t[k + x] ? 255 : 0; }
    }
    return { data: out, width: W, height: nty * T, cell: L.cell };
  }
}
