# bay-paddling

A water-first paddling guide for San Francisco Bay, starting with Richardson Bay: launches, buoys and
beacons, depth, shore ripples, a route planner that bends around land, and NOAA SFBOFS tidal currents
animated over the tide curve. Split out of trail-cartography (2026-11-18); no shared code.

    npm install
    node serve.mjs          # http://localhost:5191 (editor: labels, routes, view settings autosave to places/<place>/)
    node scripts/build.mjs  # → dist/ (public view, no editor)

## Data pipeline

    node scripts/fetch-osm.mjs <place>     # OSM incl. coastline, beaches, launches
    node scripts/fetch-aton.mjs <place>    # NOAA ENC buoys/beacons (+ places/<place>/aton-extra.json)
    node scripts/coast.mjs <place>         # join + smooth coastline
    node scripts/water.mjs <place>         # land mask → distance field → ripples.geojson + navgrid (router)
    node scripts/routes.mjs <place>        # launch/landing spots from routes.json
    node scripts/fetch-tides.mjs <place>   # NOAA high/low tide predictions

### Currents (NOAA SFBOFS), whole Bay

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python scripts/fetch-currents.py sf-bay    # → data/currents/000.png … + index.json
    node scripts/fetch-tides.mjs sf-bay

fetch-currents.py then runs tile-currents.py, which cuts each hour into a PMTiles archive (a 256-px tile
pyramid: z3 = 50 m … z0 = 400 m). The map reads only the tiles in view with HTTP range requests
(GitHub Pages supports them; serve.mjs does too), at the level that suits the zoom. The full-size
images stay local (nice to look at); only the .pmtiles and index.json are published.

Each hour's image: one RGB pixel per 50 m cell, north up: R = east-west flow, G = north-south flow
(square-root companded around 128, max 4 m/s), B = water (from the model's own mesh). ~400 KB/hour. Land comes from OpenFreeMap tiles (style "bay-tiles"),
no OSM download. Richardson Bay borrows the same tiles
("currents": {"from": "sf-bay"} in its place.json). The original Richardson-only version is tagged
richardson-v1 (checked out at ../bay-paddling-richardson, port 5192).

### Routing, whole Bay

    .venv/bin/python scripts/navgrid.py sf-bay   # once: OSM coastline → navgrid.pmtiles (0.9 MB, committed)

Distance to shore on a 12 m grid (5132 × 6817 cells), as tiles at two levels: 12 m and 48 m.
src/tile-router.js fetches the archive once, searches the 48 m level first (fast, whole Bay), then
follows that path on the 12 m level and pulls it tight around points. Water bodies that aren't
connected to the Bay (lagoons, salt ponds) are routed via the nearest main-Bay water.

## Publishing

.github/workflows/publish.yml runs four times a day (after each NOAA run) (and on every push to main): fetches the newest
NOAA forecast and tides, builds dist/ and deploys it to GitHub Pages. Nothing is committed back;
the generated data lives only in the published site.
