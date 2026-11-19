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

### Currents (NOAA SFBOFS)

    python3 -m venv .venv && .venv/bin/pip install numpy netCDF4
    .venv/bin/python scripts/fetch-sfbofs.py richardson-bay   # newest run: 6 h nowcast + 48 h forecast

Streams ~54 hourly model files (~57 MB each) from NOAA's open-data bucket, keeps the surface layer
inside the bbox on a 100 m grid, deletes each file. src/flow.js animates it.
