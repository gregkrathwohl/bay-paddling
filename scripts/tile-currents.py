"""Cut the hourly current images (fetch-currents.py) into a small tile pyramid per hour, stored as
one PMTiles archive per hour, so the map fetches only the tiles in view (HTTP range requests).

The grid is padded to 2048 × 2048 cells and cut into 256-px tiles at four levels:
  z3 = 50 m cells (8 × 8 tiles), z2 = 100 m, z1 = 200 m, z0 = 400 m (one tile for the whole Bay).
These are the grid's own tiles, not Web Mercator ones: z/x/y are just addresses in the archive.
Tiles that are all land are left out. Pixels use the same RGB encoding as the hourly images.

usage: .venv/bin/python scripts/tile-currents.py <place>   → data/currents/000.pmtiles, … (+ index.json)
"""
import io, json, os, sys
import numpy as np
from PIL import Image
from pmtiles.tile import zxy_to_tileid, TileType, Compression
from pmtiles.writer import Writer

place = sys.argv[1] if len(sys.argv) > 1 else 'sf-bay'
d = os.path.join(os.path.dirname(__file__), '..', 'places', place, 'data', 'currents')
meta = json.load(open(os.path.join(d, 'index.json')))
MAX, TILE, ZMAX = meta['encoding']['max'], 256, 3
SIZE = TILE << ZMAX
assert meta['nx'] <= SIZE and meta['ny'] <= SIZE, 'grid bigger than the pyramid: add a level'
images = meta.get('images') or meta['frames']

def decode(b):
    f = (b.astype(np.float32) - 128) / 127
    return np.sign(f) * f * f * MAX

def encode(x):
    f = np.sign(x) * np.sqrt(np.minimum(np.abs(x) / MAX, 1))
    return np.clip(np.round(128 + 127 * f), 1, 255).astype(np.uint8)

def halve(u, v, m):
    """2×2 → 1: a coarse cell is water if any of its four is; flow = mean over the water ones."""
    h, w = u.shape[0] // 2, u.shape[1] // 2
    r = lambda a: a.reshape(h, 2, w, 2)
    mw = r(m.astype(np.float32)).sum((1, 3))
    nz = np.maximum(mw, 1)
    return r(u * m).sum((1, 3)) / nz, r(v * m).sum((1, 3)) / nz, mw > 0

frames, total = [], 0
for i, name in enumerate(images):
    px = np.asarray(Image.open(os.path.join(d, name)).convert('RGB'))
    u = np.zeros((SIZE, SIZE), np.float32); v = np.zeros_like(u); m = np.zeros((SIZE, SIZE), bool)
    ny, nx = px.shape[:2]
    m[:ny, :nx] = px[..., 2] > 127
    u[:ny, :nx] = np.where(m[:ny, :nx], decode(px[..., 0]), 0)
    v[:ny, :nx] = np.where(m[:ny, :nx], decode(px[..., 1]), 0)
    tiles = {}
    for z in range(ZMAX, -1, -1):
        n = 1 << z
        for ty in range(n):
            for tx in range(n):
                sl = np.s_[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
                tm = m[sl]
                if not tm.any(): continue
                rgb = np.zeros((TILE, TILE, 3), np.uint8); rgb[..., :2] = 128
                rgb[tm, 0] = encode(u[sl][tm]); rgb[tm, 1] = encode(v[sl][tm]); rgb[tm, 2] = 255
                buf = io.BytesIO(); Image.fromarray(rgb).save(buf, 'PNG', optimize=True)
                tiles[zxy_to_tileid(z, tx, ty)] = buf.getvalue()
        if z: u, v, m = halve(u, v, m)
    out = f'{i:03d}.pmtiles'
    with open(os.path.join(d, out), 'wb') as f:
        w = Writer(f)
        for tid in sorted(tiles): w.write_tile(tid, tiles[tid])
        b = meta['bbox']
        w.finalize({'tile_type': TileType.PNG, 'tile_compression': Compression.NONE, 'min_zoom': 0, 'max_zoom': ZMAX,
                    'min_lon_e7': int(b[0] * 1e7), 'min_lat_e7': int(b[1] * 1e7), 'max_lon_e7': int(b[2] * 1e7), 'max_lat_e7': int(b[3] * 1e7),
                    'center_zoom': 0, 'center_lon_e7': int((b[0] + b[2]) / 2 * 1e7), 'center_lat_e7': int((b[1] + b[3]) / 2 * 1e7)},
                   {'time': meta['times'][i], 'encoding': meta['encoding'], 'cell': meta['cell']})
    frames.append(out); total += os.path.getsize(os.path.join(d, out))
    print(f'{out}: {len(tiles)} tiles, {os.path.getsize(os.path.join(d, out)) / 1e3:.0f} KB', flush=True)

meta.update(images=images, frames=frames, tiles={'size': TILE, 'maxzoom': ZMAX, 'cell': meta['cell'], 'origin': [meta['bbox'][0], meta['bbox'][3]]})
json.dump(meta, open(os.path.join(d, 'index.json'), 'w'), indent=1)
print(f'{len(frames)} archives, {total / 1e6:.1f} MB', flush=True)
