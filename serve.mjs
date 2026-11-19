// Tiny dev server: serves the project folder and lets the editor save labels, routes
// and settings back to places/<place>/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.PORT || 5191);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();

  // PUT /places/<place>/labels.json | trips.json — save from the label editor / route planner
  if (req.method === 'PUT') {
    if (!/^\/places\/[\w-]+\/(labels|trips)\.json$/.test(url.pathname)) return res.writeHead(403).end();
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { JSON.parse(body); } catch { return res.writeHead(400).end('bad json'); }
      fs.writeFileSync(file, body);
      res.writeHead(204).end();
    });
    return;
  }

  // POST /api/settings/<place> {defaults} — the editor's autosave: merged into place.json
  const sm = req.method === 'POST' && url.pathname.match(/^\/api\/settings\/([\w-]+)$/);
  if (sm) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const { defaults } = JSON.parse(body || '{}');
        const cfgFile = path.join(root, 'places', sm[1], 'place.json');
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        if (defaults) cfg.defaults = { ...(cfg.defaults || {}), ...defaults };
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      } catch (e) { res.writeHead(500).end(String(e?.message || e)); }
    });
    return;
  }

  let p = file;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`bay-paddling on http://localhost:${port}`));
