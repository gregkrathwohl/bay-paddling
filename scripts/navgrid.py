"""Route grid for a big area (the whole Bay): distance to shore for every water cell, as tiles.

  1. OSM coastline for the bbox (Overpass), drawn as barriers on a 12 m grid; the bbox edge is a
     barrier too, so land and water can't connect around the outside of the map
  2. water = the regions holding place.json navgrid.seeds (4-connected, so no leaks through diagonals)
  3. exact Euclidean distance to land (scipy)
  4. one PMTiles archive, two levels of 256-px tiles (these are the grid's own tiles, not Web Mercator):
       z5 = 12 m cells (fine: hugging the shore), z3 = 48 m cells (coarse: the first, fast search)
     pixel value = distance to land in 12 m units (both levels), capped at 255 (~3 km); 0 = land.
     Coarse cells take the *largest* distance of the fine cells they cover, so narrow channels stay
     connected in the fast coarse search; the fine pass then keeps the real distance from shore.

The coastline doesn't change, so this runs once (not in the publish job) and the archive is committed.
usage: .venv/bin/python scripts/navgrid.py <place>  → places/<place>/data/navgrid.pmtiles (+ navgrid.json)
"""
import io, json, math, os, sys, urllib.parse, urllib.request
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from pmtiles.tile import zxy_to_tileid, TileType, Compression
from pmtiles.writer import Writer

place = sys.argv[1] if len(sys.argv) > 1 else 'sf-bay'
root = os.path.join(os.path.dirname(__file__), '..', 'places', place)
cfg = json.load(open(os.path.join(root, 'place.json')))
nav = cfg['navgrid']
w, s, e, n = cfg['bbox']
CELL, TILE, ZF, ZC = 12, 256, 5, 3           # fine level z5, coarse z3 (4× coarser)
lat0 = (s + n) / 2
mx, my = 111320 * math.cos(math.radians(lat0)), 110540
W, H = math.ceil((e - w) * mx / CELL), math.ceil((n - s) * my / CELL)
SIZE = TILE << ZF
assert W <= SIZE and H <= SIZE, 'grid bigger than the pyramid'
print(f'grid {W}×{H} @ {CELL} m', flush=True)

# 1. coastline (cached: it doesn't change)
cache = os.path.join(root, 'data', 'coastline.json')
if not os.path.exists(cache):
    q = f'[out:json][timeout:180];way["natural"="coastline"]({s},{w},{n},{e});out geom;'
    req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(),
                                 headers={'User-Agent': 'bay-paddling/1.0'})
    open(cache, 'w').write(urllib.request.urlopen(req, timeout=300).read().decode())
ways = json.load(open(cache))['elements']
print(f'{len(ways)} coastline ways', flush=True)

img = Image.new('1', (W, H), 0)
draw = ImageDraw.Draw(img)
for way in ways:
    pts = [((p['lon'] - w) * mx / CELL, (n - p['lat']) * my / CELL) for p in way['geometry']]
    draw.line(pts, fill=1, width=1)
draw.rectangle([0, 0, W - 1, H - 1], outline=1)          # the bbox edge
barrier = np.asarray(img, dtype=bool)

# 2. water = regions containing a seed
labels, count = ndimage.label(~barrier)                  # default structure = 4-connected
keep = set()
for lon, lat in nav['seeds']:
    x, y = int((lon - w) * mx / CELL), int((n - lat) * my / CELL)
    if labels[y, x] == 0: print(f'seed {lon},{lat} is on a coastline: move it', flush=True)
    keep.add(labels[y, x])
water = np.isin(labels, list(keep - {0}))
print(f'water {100 * water.mean():.1f}% of grid', flush=True)

# 3. distance to land, metres
dist = ndimage.distance_transform_edt(water).astype(np.float32) * CELL
del labels, barrier

# 4. tiles
def level(z):
    f = 1 << (ZF - z)                                      # fine cells per cell at this level
    cell = CELL * f
    h, wd = math.ceil(H / f), math.ceil(W / f)
    pad = np.zeros((h * f, wd * f), np.float32); pad[:H, :W] = dist
    m = pad.reshape(h, f, wd, f).max((1, 3)) if f > 1 else pad
    return np.minimum(255, np.floor(m / CELL)).astype(np.uint8)

tiles = {}
for z in (ZF, ZC):
    g = level(z)
    nt = 1 << z
    for ty in range(nt):
        for tx in range(nt):
            t = g[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
            if not t.size or not t.any(): continue
            full = np.zeros((TILE, TILE), np.uint8); full[:t.shape[0], :t.shape[1]] = t
            buf = io.BytesIO(); Image.fromarray(full, 'L').save(buf, 'PNG', optimize=True)
            tiles[zxy_to_tileid(z, tx, ty)] = buf.getvalue()
    print(f'z{z}: {len(tiles)} tiles so far', flush=True)

out = os.path.join(root, 'data', 'navgrid.pmtiles')
with open(out, 'wb') as f:
    wr = Writer(f)
    for tid in sorted(tiles): wr.write_tile(tid, tiles[tid])
    wr.finalize({'tile_type': TileType.PNG, 'tile_compression': Compression.NONE, 'min_zoom': ZC, 'max_zoom': ZF,
                 'min_lon_e7': int(w * 1e7), 'min_lat_e7': int(s * 1e7), 'max_lon_e7': int(e * 1e7), 'max_lat_e7': int(n * 1e7),
                 'center_zoom': ZC, 'center_lon_e7': int((w + e) / 2 * 1e7), 'center_lat_e7': int(lat0 * 1e7)}, {})
json.dump({'bbox': [w, s, e, n], 'origin': [w, n], 'lat0': lat0, 'cell': CELL, 'width': W, 'height': H,
           'tile': TILE, 'fine': ZF, 'coarse': ZC}, open(os.path.join(root, 'data', 'navgrid.json'), 'w'), indent=1)
print(f'navgrid.pmtiles: {len(tiles)} tiles, {os.path.getsize(out) / 1e6:.1f} MB', flush=True)
