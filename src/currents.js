// The current field for the flow layer: sample(t, lng, lat) → [east, north] m/s (or null over land /
// while loading), with t a fractional hour index into `times`.
// One PMTiles archive per hour (scripts/tile-currents.py): a 256-px tile pyramid of the model grid,
// z3 = 50 m … z0 = 400 m. Only tiles in view are fetched, by HTTP range request, at the level that
// suits the zoom.
import { PMTiles } from 'pmtiles';

const MY = 110540;   // metres per degree of latitude

export async function tileField(dir) {
  const meta = await fetch(`${dir}/index.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!meta?.tiles) return null;
  const { size: S, maxzoom: ZMAX, cell: CELL, origin: [w, nN] } = meta.tiles;
  const mx = 111320 * Math.cos(((meta.bbox[1] + meta.bbox[3]) / 2) * Math.PI / 180);
  const lut = new Float32Array(256);   // byte → m/s (square-root companding, see fetch-currents.py)
  for (let b = 0; b < 256; b++) { const f = (b - 128) / 127; lut[b] = Math.sign(f) * f * f * meta.encoding.max; }
  const archives = [], cache = new Map();   // key "t/z/x/y" → { u, v, m } | null (all land) | Promise
  const LIMIT = 200;                        // tiles kept in memory (~200 KB each)
  let z = ZMAX;                             // level for the current view

  const archive = (t) => (archives[t] ||= new PMTiles(`${dir}/${meta.frames[t]}`));
  const load = (t, tz, tx, ty) => {
    const key = `${t}/${tz}/${tx}/${ty}`;
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return; }   // refresh LRU order
    cache.set(key, (async () => {
      const r = await archive(t).getZxy(tz, tx, ty).catch(() => null);
      if (!r?.data) { cache.set(key, null); return; }
      const bmp = await createImageBitmap(new Blob([r.data], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const ctx = new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, S, S).data, n = S * S;
      const u = new Float32Array(n), v = new Float32Array(n), m = new Uint8Array(n);
      for (let i = 0; i < n; i++) { m[i] = px[i * 4 + 2] > 127; u[i] = lut[px[i * 4]]; v[i] = lut[px[i * 4 + 1]]; }
      if (cache.has(key)) cache.set(key, { u, v, m });
    })());
    for (const k of cache.keys()) { if (cache.size <= LIMIT) break; if (!(cache.get(k) instanceof Promise)) cache.delete(k); }
  };
  // one cell at level tz, hour t: [u, v] or null (land, outside, or not loaded yet → undefined)
  const cellAt = (t, tz, cx, cy) => {
    const tile = cache.get(`${t}/${tz}/${Math.floor(cx / S)}/${Math.floor(cy / S)}`);
    if (!tile || tile instanceof Promise) return tile === null ? null : undefined;
    const i = (cy % S) * S + (cx % S);
    return tile.m[i] ? [tile.u[i], tile.v[i]] : null;
  };
  // bilinear at one level and hour; undefined if any needed tile is still loading
  const at = (t, tz, lng, lat) => {
    const cell = CELL * (1 << (ZMAX - tz)), N = S << tz;
    const gx = ((lng - w) * mx) / cell - 0.5, gy = ((nN - lat) * MY) / cell - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    let u = 0, v = 0, ws = 0;
    for (const [cx, cy, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
      if (cx < 0 || cy < 0 || cx >= N || cy >= N) continue;
      const c = cellAt(t, tz, cx, cy);
      if (c === undefined) return undefined;
      if (!c) continue;
      u += wt * c[0]; v += wt * c[1]; ws += wt;
    }
    return ws < 0.3 ? null : [u / ws, v / ws];
  };
  const hour = (t, lng, lat) => {
    // the view's level, else the nearest coarser one that has arrived (z0 is always requested)
    for (let tz = z; tz >= 0; tz--) { const r = at(t, tz, lng, lat); if (r !== undefined) return r; }
    return null;
  };

  const field = {
    times: meta.times, nowcast: meta.nowcast,
    sample(t, lng, lat) {
      const t0 = Math.floor(t), t1 = Math.min(meta.times.length - 1, t0 + 1), ft = t - t0;
      const a = hour(t0, lng, lat);
      if (!a || ft < 0.01) return a;
      const b = hour(t1, lng, lat);
      return b ? [a[0] * (1 - ft) + b[0] * ft, a[1] * (1 - ft) + b[1] * ft] : a;
    },
    // called by the flow layer after each pan/zoom and time change: pick the level, fetch what's in view
    view({ west, east, south, north }, mPerPx, t) {
      z = Math.max(0, Math.min(ZMAX, ZMAX - Math.floor(Math.log2(Math.max(1, (mPerPx * 3) / CELL)))));
      const cell = CELL * (1 << (ZMAX - z)), n = 1 << z;
      const tx = (lng) => Math.max(0, Math.min(n - 1, Math.floor(((lng - w) * mx) / cell / S)));
      const ty = (lat) => Math.max(0, Math.min(n - 1, Math.floor(((nN - lat) * MY) / cell / S)));
      const t0 = Math.floor(t);
      for (const h of [t0, t0 + 1, t0 + 2]) {
        if (h < 0 || h >= meta.times.length) continue;
        load(h, 0, 0, 0);
        for (let y = ty(north); y <= ty(south); y++) for (let x = tx(west); x <= tx(east); x++) load(h, z, x, y);
      }
    },
    get level() { return z; },
    get cached() { return cache.size; },
  };
  return field;
}
