"""Surface currents from NOAA SFBOFS as one RGB image per hour, for big areas (the whole Bay).

Each pixel is one grid cell (default 50 m), north up:
  R = east-west flow (u), G = north-south flow (v), B = 255 for water, 0 for land.
u and v are stored with square-root companding so slow water keeps detail:
  byte = 128 + round(127 * sign(x) * sqrt(|x| / max)),  x in m/s, max from place.json (default 4)
  decode: f = (byte - 128) / 127;  x = sign(f) * f² * max
A neutral grey (128,128) is still water; land is black-ish with B = 0.

The water mask is the model's own mesh: a cell is water if it falls inside an FVCOM triangle.
Values are linear (barycentric) interpolation between model element centres: smooth, no terraces.
(The first version used the 3 nearest centres, inverse-distance weighted, which left faint
patches that dense streaks made visible.) Cells outside the centres' hull use the nearest one.

usage: .venv/bin/python scripts/fetch-currents.py <place> [YYYY/MM/DD] [run e.g. t15z]
needs: numpy netCDF4 scipy matplotlib pillow
  → places/<place>/data/currents/index.json + 000.png, 001.png, …
"""
import json, os, re, sys, tempfile, urllib.request, datetime as dt
import numpy as np, netCDF4
from scipy.spatial import cKDTree, Delaunay
from matplotlib.tri import Triangulation
from PIL import Image

place = sys.argv[1] if len(sys.argv) > 1 else 'sf-bay'
root = os.path.join(os.path.dirname(__file__), '..', 'places', place)
cfg = json.load(open(os.path.join(root, 'place.json')))
cc = cfg.get('currents', {})
w, s, e, n = cc.get('bbox', cfg['bbox'])
CELL, MAX = cc.get('cell', 50), cc.get('max', 4.0)
out_dir = os.path.join(root, 'data', 'currents')
BUCKET = 'https://noaa-nos-ofs-pds.s3.amazonaws.com'

def list_keys(day):
    listing = urllib.request.urlopen(f'{BUCKET}/?list-type=2&prefix=sfbofs/netcdf/{day}/&max-keys=1000').read().decode()
    return re.findall(r'<Key>([^<]+fields\.[nf]\d{3}\.nc)</Key>', listing)

def complete_runs(keys):
    return sorted(r for r in {re.search(r'\.(t\d\dz)\.', k).group(1) for k in keys}
                  if sum(f'.{r}.' in k and 'fields.f' in k for k in keys) >= 48)

if len(sys.argv) > 2:
    day = sys.argv[2]; keys = list_keys(day)
else:
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(3):
        day = (now - dt.timedelta(days=back)).strftime('%Y/%m/%d'); keys = list_keys(day)
        if complete_runs(keys): break
run = sys.argv[3] if len(sys.argv) > 3 else complete_runs(keys)[-1]
keys = sorted(k for k in keys if f'.{run}.' in k and not k.endswith('n000.nc') and not k.endswith('f000.nc'))
keys = sorted(set(keys), key=lambda k: (0 if re.search(r'fields\.n\d', k) else 1, k))  # nowcast first
print(f'{day} {run}: {len(keys)} hourly files', flush=True)

# regular target grid (cell centres), in local metres
lat0 = (s + n) / 2
mx, my = 111320 * np.cos(np.radians(lat0)), 110540
nx, ny = int(np.ceil((e - w) * mx / CELL)), int(np.ceil((n - s) * my / CELL))
GX, GY = np.meshgrid(w + (np.arange(nx) + 0.5) * CELL / mx, n - (np.arange(ny) + 0.5) * CELL / my)

def encode(x):
    f = np.sign(x) * np.sqrt(np.minimum(np.abs(x) / MAX, 1))
    return np.clip(np.round(128 + 127 * f), 1, 255).astype(np.uint8)

os.makedirs(out_dir, exist_ok=True)
for f in os.listdir(out_dir):
    if f.endswith('.png'): os.remove(os.path.join(out_dir, f))

sel = idx = wts = water = None
times = []
tmp = tempfile.mkdtemp()
for i, k in enumerate(keys):
    path = os.path.join(tmp, 'f.nc')
    urllib.request.urlretrieve(f'{BUCKET}/{k}', path)
    ds = netCDF4.Dataset(path)
    if sel is None:
        lon, lat = ds['lon'][:].data - 360, ds['lat'][:].data
        nv = ds['nv'][:].data.T - 1                       # triangles: node indices (0-based)
        lonc, latc = ds['lonc'][:].data - 360, ds['latc'][:].data
        pad = 0.02
        sel = np.where((lonc > w - pad) & (lonc < e + pad) & (latc > s - pad) & (latc < n + pad))[0]
        # water = inside a model triangle
        tri = Triangulation(lon, lat, nv[sel])
        water = (tri.get_trifinder()(GX.ravel(), GY.ravel()) >= 0)
        # linear interpolation on a triangulation of the element centres (weights computed once)
        ctr = np.c_[(lonc[sel] - w) * mx, (n - latc[sel]) * my]
        pts = np.c_[(GX.ravel()[water] - w) * mx, (n - GY.ravel()[water]) * my]
        dt = Delaunay(ctr)
        simp = dt.find_simplex(pts)
        inside = simp >= 0
        T = dt.transform[simp[inside]]
        b = np.einsum('ijk,ik->ij', T[:, :2], pts[inside] - T[:, 2])
        idx = np.zeros((len(pts), 3), int); wts = np.zeros((len(pts), 3))
        idx[inside] = dt.simplices[simp[inside]]; wts[inside] = np.c_[b, 1 - b.sum(1)]
        _, near = cKDTree(ctr).query(pts[~inside]); idx[~inside, 0] = near; wts[~inside, 0] = 1
        print(f'{sel.size} mesh elements → grid {nx}×{ny} @ {CELL} m, {water.sum()} water cells', flush=True)
    u = ds['u'][0, 0, :].data[sel]; v = ds['v'][0, 0, :].data[sel]
    t = netCDF4.num2date(ds['time'][0], ds['time'].units, only_use_cftime_datetimes=False)
    ds.close(); os.remove(path)
    img = np.zeros((nx * ny, 3), np.uint8)
    img[:, 0] = img[:, 1] = 128
    img[water, 0] = encode((u[idx] * wts).sum(1))
    img[water, 1] = encode((v[idx] * wts).sum(1))
    img[water, 2] = 255
    Image.fromarray(img.reshape(ny, nx, 3), 'RGB').save(os.path.join(out_dir, f'{i:03d}.png'), optimize=True)
    times.append(t.strftime('%Y-%m-%dT%H:%M:%SZ'))
    sp = np.hypot((u[idx] * wts).sum(1), (v[idx] * wts).sum(1))
    print(times[-1], k.split('.')[-2], f'max {sp.max():.2f} m/s', flush=True)

json.dump({'source': f'NOAA SFBOFS {day} {run}', 'bbox': [w, s, e, n], 'nx': nx, 'ny': ny, 'cell': CELL,
           'encoding': {'type': 'sqrt', 'max': MAX}, 'times': times,
           'frames': [f'{i:03d}.png' for i in range(len(times))],
           'nowcast': sum(bool(re.search(r'fields\.n\d', k)) for k in keys)},
          open(os.path.join(out_dir, 'index.json'), 'w'), indent=1)
print('wrote currents/index.json', flush=True)

# then cut them into per-hour tile archives for the map
import subprocess
subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'tile-currents.py'), place], check=True)
