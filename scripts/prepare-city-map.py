"""Convert downloaded OpenFreeMap z14 tiles and an OSRM GeoJSON response to local scene units.

Requires mapbox-vector-tile and shapely. See docs/CITY-MAP.md for inputs.
"""
import json
import math
import sys
from pathlib import Path

from mapbox_vector_tile import decode
from shapely import make_valid
from shapely.geometry import box, shape
from shapely.ops import transform

ORIGIN_LON, ORIGIN_LAT = 108.959, 34.2215
UNITS_PER_DEGREE = 40075016.686 * math.cos(math.radians(ORIGIN_LAT)) / 360 / 200
AREA = box(-6.9, -6.9, 6.9, 6.9)
ARTERIAL = {"motorway", "trunk", "primary", "secondary", "tertiary"}


def mercator_y(lat):
    return math.asinh(math.tan(math.radians(lat)))


def project_route(lon, lat):
    return [
        round((lon - ORIGIN_LON) * UNITS_PER_DEGREE, 4),
        round((mercator_y(ORIGIN_LAT) - mercator_y(lat)) * 180 / math.pi * UNITS_PER_DEGREE, 4),
    ]


def parts(geometry, kind):
    if geometry.is_empty:
        return
    if geometry.geom_type == kind:
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from parts(part, kind)


def points(coords):
    return [[round(x, 4), round(y, 4)] for x, y in coords]


def build(folder, response):
    result = {"localRoads": [], "mainRoads": [], "buildings": [], "water": []}
    for tile in sorted(folder.glob("*.pbf")):
        tx, ty = map(int, tile.stem.split("-"))
        layers = decode(tile.read_bytes(), default_options={"y_coord_down": True})
        for name in ("transportation", "building", "water"):
            layer = layers[name]
            extent = layer["extent"]

            def project(x, y):
                return (
                    ((tx + x / extent) / 2**14 * 360 - 180 - ORIGIN_LON) * UNITS_PER_DEGREE,
                    ((ty + y / extent) / 2**14 * 360 - 180 + math.degrees(mercator_y(ORIGIN_LAT))) * UNITS_PER_DEGREE,
                )

            # Vector tiles have a buffered edge; clip to the actual tile before
            # joining the scene to avoid drawing buffered features twice.
            tile_area = box(*project(0, 0), *project(extent, extent)).intersection(AREA)
            for feature in layer["features"]:
                props = feature["properties"]
                road = props.get("class")
                if name == "transportation" and road not in ARTERIAL | {"minor", "service"}:
                    continue
                geom = make_valid(transform(project, shape(feature["geometry"]))).intersection(tile_area).simplify(.012)
                if name == "transportation":
                    target = "mainRoads" if road in ARTERIAL else "localRoads"
                    result[target].extend(points(line.coords) for line in parts(geom, "LineString") if line.length > .045)
                else:
                    for poly in parts(geom, "Polygon"):
                        if poly.area < .001:
                            continue
                        ring = points(poly.exterior.coords)
                        if name == "building":
                            result["buildings"].append({
                                "heightMeters": props.get("render_height", 5),
                                "outline": ring,
                            })
                        else:
                            result["water"].append(ring)
    route = response["routes"][0]
    result["route"] = [project_route(*coordinate) for coordinate in route["geometry"]["coordinates"]]
    result["distanceMeters"] = route["distance"]
    result["durationSeconds"] = route["duration"]
    assert all(result.values()), "Missing city data"
    return result


if __name__ == "__main__":
    tiles, route_file, output = map(Path, sys.argv[1:])
    data = build(tiles, json.loads(route_file.read_text()))
    output.write_text("{\n" + ",\n".join(
        f"  {json.dumps(key)}: {json.dumps(value, separators=(',', ':'))}" for key, value in data.items()
    ) + "\n}\n")
