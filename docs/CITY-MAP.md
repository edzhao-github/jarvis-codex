# Xi’an map snapshot

The desktop map uses an offline extract around Yanta, Xi’an. The included
route is a fixed driving example from Anhua West Road to Datang Everbright City
(3.341 km, 379 seconds according to OSRM). It does not include live traffic.

- Roads, building footprints and water: [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
  via [OpenFreeMap](https://openfreemap.org/) / © [OpenMapTiles](https://openmaptiles.org/).
  The adapted data in `src/data/xian-map.json` is available under
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- Route: [FOSSGIS OSRM](https://routing.openstreetmap.de/), based on OpenStreetMap data.
- The wireframe uses the tiles’ render heights, which include estimates.
  The app exaggerates these heights for readability, and the floating lights
  are decorative.

To regenerate, download tiles named `{x}-{y}.pbf` for z=14,
x=13150…13151 and y=6532…6533 from the OpenFreeMap TileJSON
(`https://tiles.openfreemap.org/planet`; snapshot used here:
`20261101_080013_pt`). Save the response from
`https://routing.openstreetmap.de/routed-car/route/v1/driving/108.949,34.230;108.9607,34.2158?overview=full&geometries=geojson`
to `route.json`. With Python packages `mapbox-vector-tile` and `shapely`
installed, run:

```sh
python scripts/prepare-city-map.py tiles route.json src/data/xian-map.json
```
