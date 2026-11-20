// Experiment: attach each mark's light (flash pattern, period, colour) from NOAA ENC Direct's light layer.
// usage: node scripts/add-lights.mjs sf-bay   (rewrites places/<place>/data/aton.geojson in place)
import fs from 'node:fs';
const place = process.argv[2] || 'sf-bay';
const [w, s, e, n] = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8')).bbox;
const q = new URLSearchParams({ geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects', outFields: '*', outSR: '4326', f: 'geojson' });
const j = await (await fetch(`https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_harbour/MapServer/11/query?${q}`)).json();
const lights = j.features || [];
console.log('lights', lights.length, lights[0]?.properties);
// S-57 LITCHR → a simple pattern we can animate
const CHR = { 1: 'F', 2: 'Fl', 3: 'LFl', 4: 'Q', 5: 'VQ', 6: 'UQ', 7: 'Iso', 8: 'Oc', 9: 'IQ', 25: 'Q', 28: 'Al' };
const COL = { 1: 'white', 3: 'red', 4: 'green', 6: 'yellow' };
const path = `places/${place}/data/aton.geojson`, g = JSON.parse(fs.readFileSync(path, 'utf8'));
const d = (a, b) => Math.hypot((a[0] - b[0]) * 79000, (a[1] - b[1]) * 111000);
let hit = 0;
for (const f of g.features) {
  let best = null, bd = 20;
  for (const l of lights) { const k = d(f.geometry.coordinates, l.geometry.coordinates); if (k < bd) { bd = k; best = l; } }
  if (!best) continue;
  const p = best.properties;
  f.properties.lchr = CHR[+p.LITCHR] || 'Fl';
  f.properties.lper = +p.SIGPER || (f.properties.lchr === 'Q' ? 1 : 4);
  f.properties.lrng = +best.properties.VALNMR || 2;
  f.properties.lcol = COL[parseInt(String(p.COLOUR).split(',')[0])] || 'white';
  hit++;
}
fs.writeFileSync(path, JSON.stringify(g));
console.log('lit marks', hit, 'of', g.features.length);
