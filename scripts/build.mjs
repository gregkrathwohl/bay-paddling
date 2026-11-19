// Static build for GitHub Pages → dist/
//   index.html  = the map, in public mode (no editor, grid, tuning, route saving)
//   vendor/     = maplibre-gl + maplibre-contour
//   places/<id> = place config + the data the map loads
// Paths are relative, so it works under any sub-path.
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(from, path.join(out, to)); };

for (const f of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) copy(`node_modules/maplibre-gl/dist/${f}`, `vendor/maplibre-gl/${f}`);
copy('node_modules/maplibre-contour/dist/index.mjs', 'vendor/maplibre-contour/index.mjs');
copy('node_modules/pmtiles/dist/esm/index.js', 'vendor/pmtiles/index.js');
copy('node_modules/fflate/esm/browser.js', 'vendor/fflate/browser.js');
for (const f of fs.readdirSync('src')) copy(`src/${f}`, `src/${f}`);

const html = fs.readFileSync('index.html', 'utf8')
  .replaceAll('node_modules/maplibre-gl/dist/', 'vendor/maplibre-gl/')
  .replace('./node_modules/maplibre-contour/dist/index.mjs', './vendor/maplibre-contour/index.mjs')
  .replace('./node_modules/pmtiles/dist/esm/index.js', './vendor/pmtiles/index.js')
  .replace('./node_modules/fflate/esm/browser.js', './vendor/fflate/browser.js')
  .replace('<body>', '<body data-public>');
fs.writeFileSync(path.join(out, 'index.html'), html);

const KEEP = ['place.json', 'labels.json', 'trips.json', 'routes.json'];
const DATA = ['osm.geojson', 'aton.geojson', 'coast.geojson', 'ripples.geojson', 'routes.geojson',
  'navgrid.png', 'navgrid.json', 'navgrid.pmtiles', 'tides.json'];
for (const id of fs.readdirSync('places')) {
  const dir = `places/${id}`;
  if (!fs.existsSync(`${dir}/place.json`)) continue;
  for (const f of KEEP) if (fs.existsSync(`${dir}/${f}`)) copy(`${dir}/${f}`, `${dir}/${f}`);
  for (const f of DATA) if (fs.existsSync(`${dir}/data/${f}`)) copy(`${dir}/data/${f}`, `${dir}/data/${f}`);
  // tiled currents: the index and one archive per hour (not the full-size images)
  const cur = `${dir}/data/currents`;
  if (fs.existsSync(`${cur}/index.json`)) for (const f of fs.readdirSync(cur)) if (/\.pmtiles$|^index\.json$/.test(f)) copy(`${cur}/${f}`, `${cur}/${f}`);
}
fs.writeFileSync(path.join(out, '.nojekyll'), '');

let bytes = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : (bytes += fs.statSync(path.join(d, e.name)).size));
walk(out);
console.log(`dist/: ${(bytes / 1e6).toFixed(1)} MB`);
