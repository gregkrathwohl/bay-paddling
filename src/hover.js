// What's under the cursor: current speed and direction, water depth, and a buoy's full name.
// A small card follows the pointer (mouse and trackpad only; touch has no hover).
//
// Depth comes from the same AWS Terrain Tiles (Terrarium) the depth tint is drawn from: we fetch the
// z12 tile under the cursor once, decode it, and read the pixel. It's approximate (~MSL, ~30 m cells).

const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const Z = 12, KN = 1.94384, FT = 3.28084;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const tiles = new Map();   // "x/y" → Float32Array (metres) | Promise | null
function demTile(x, y) {
  const k = `${x}/${y}`;
  if (!tiles.has(k)) tiles.set(k, (async () => {
    try {
      const blob = await fetch(`${DEM}/${Z}/${x}/${y}.png`).then(r => (r.ok ? r.blob() : Promise.reject()));
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const ctx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data, h = new Float32Array(256 * 256);
      for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      tiles.set(k, h);
    } catch { tiles.set(k, null); }
  })());
  const v = tiles.get(k);
  return v instanceof Promise ? undefined : v;
}
// elevation in metres (negative = below sea level), or undefined while its tile loads
function elevation(lng, lat) {
  const n = 2 ** Z, fx = ((lng + 180) / 360) * n, r = lat * Math.PI / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const tx = Math.floor(fx), ty = Math.floor(fy), t = demTile(tx, ty);
  if (t === undefined) return undefined;
  if (t === null) return null;
  return t[Math.floor((fy - ty) * 256) * 256 + Math.floor((fx - tx) * 256)];
}

export function hoverInfo(map, { flow, isWater, buoyLayers = ['buoy', 'beacon', 'aton-label'] }) {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const card = document.createElement('div');
  card.className = 'hover-card'; card.hidden = true;
  document.body.appendChild(card);
  let last = null, raf = 0;

  const render = () => {
    raf = 0;
    if (!last || document.body.classList.contains('screensaver')) { card.hidden = true; return; }
    const { point, lngLat: { lng, lat } } = last, rows = [];
    // a buoy or beacon right under the pointer: its chart name first
    const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
    const mark = map.queryRenderedFeatures(box, { layers: buoyLayers.filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none') })[0];
    if (mark) rows.push(`<b>${mark.properties.name || mark.properties.label}</b>`);
    const water = isWater ? isWater(lng, lat) : true;
    if (water && flow?.visible !== false) {
      const v = flow?.data.sample(flow.t, lng, lat);
      if (v) {
        const sp = Math.hypot(v[0], v[1]) * KN, dir = (Math.atan2(v[0], v[1]) * 180 / Math.PI + 360) % 360;
        rows.push(sp < 0.05 ? 'Current: slack' : `Current <b>${sp.toFixed(1)} kn</b> toward ${POINTS[Math.round(dir / 22.5) % 16]}`);
      }
    }
    if (water) {
      const h = elevation(lng, lat);
      if (h === undefined) setTimeout(() => last && !raf && (raf = requestAnimationFrame(render)), 150);
      else if (h != null && h < -0.5) rows.push(`Depth ~<b>${Math.round(-h * FT)} ft</b>`);
    }
    card.hidden = !rows.length;
    if (!rows.length) return;
    card.innerHTML = rows.join('<br>');
    // beside the pointer, flipped near the right / bottom edges
    const r = map.getContainer().getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    const x = r.left + point.x + 16, y = r.top + point.y + 16;
    card.style.left = `${x + w > innerWidth - 8 ? x - w - 28 : x}px`;
    card.style.top = `${y + h > innerHeight - 8 ? y - h - 28 : y}px`;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };
  map.on('mousemove', (ev) => { last = ev; schedule(); });
  map.on('mouseout', () => { last = null; card.hidden = true; });
  map.on('dragstart', () => { card.hidden = true; });
  // the current under a still pointer changes as the tide plays
  setInterval(() => { if (last) schedule(); }, 500);
}
