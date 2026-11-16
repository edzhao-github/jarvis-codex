import { classifyRings, VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

export type Point = [number, number];
export type CityScene = {
  localRoads: number[][][];
  mainRoads: number[][][];
  water: number[][][];
  buildings: { heightMeters: number; outline: number[][] }[];
  route: Point[];
  originPoint: Point | null;
  destinationPoint: Point;
  distanceMeters: number;
  durationSeconds: number;
};
export type Place = { point: Point; name: string; area: string; city?: string; approximate?: boolean };

export class PlaceNotFoundError extends Error {
  constructor(query: string, readonly field: "origin" | "destination", precise: boolean, question?: string) {
    const label = field === "origin" ? "起点" : precise ? "目的地" : "地点";
    const subject = query ? `${label}「${query}」` : label;
    super(question ?? (query
      ? `没能确定${subject}。可以说一下在哪个区，或者旁边有什么地标？`
      : `你想从哪儿出发？说个地点或附近的地标就行。`));
  }
}

const maxLatitude = 85.05112878;
const roadClasses = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const localClasses = new Set(["minor", "service", "path"]);

async function request(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  if (!response.ok) throw new Error(`地图服务暂时不可用（${response.status}）。`);
  return response;
}

function isPoint(point: unknown): point is Point {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= maxLatitude;
}

type SearchBounds = [number, number, number, number];
type PlaceFeature = {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
};

async function searchPhoton(query: string, signal: AbortSignal, bounds?: SearchBounds) {
  const params = new URLSearchParams({ q: query, limit: "10" });
  if (bounds) params.set("bbox", bounds.join(","));
  const result: { features?: PlaceFeature[] } =
    await (await request(`https://photon.komoot.io/api/?${params}`, signal)).json();
  return result.features ?? [];
}

const cityPrefix = /^([\p{Script=Han}]{2,5}?市)(.+)$/u;
const knownCityPrefix = /^((?:大连|北京|上海|广州|深圳|杭州|南京|成都|重庆|西安)(?!路|街|巷))(.+)$/;
const compact = (text: string) => text.normalize("NFKC").replace(/[\s·]/g, "").toLowerCase();
const nearbySuffix = /(?:附近(?:一带)?|周边|一带|那一片|那边|那里|这边|这一片|左右)(?:儿)?$/;
const placeSuffix = /(?:国际机场|机场|广场|购物中心|商场|家居|大厦|小区|公园|博物馆|小学|中学|火车站|地铁站|街道|区|县|镇|[一二三四五六七八九十0-9]+期)$/;
const areaTypes = new Set(["city", "county", "district", "locality", "street", "state"]);
const spokenDigits = "零一二三四五六七八九";

// The provider does not index these local names under their common wording.
function dalianAlias(name: string, city: string) {
  if (city.replace(/市$/, "") !== "大连") return undefined;
  if (/^(?:周水子(?:国际机场|机场)?|国际机场|机场)$/.test(name)) {
    return { query: "大连周水子国际机场" };
  }
  if (/^(?:高新(?:区)?万达(?:广场)?|万达(?:广场)?高新店)$/.test(name)) {
    return { query: "大连高新万达广场" };
  }
  if (/^(?:甘井子(?:区)?万达(?:广场)?|万达(?:广场)?甘井子店)$/.test(name)) {
    return { query: "万达广场大连甘井子店" };
  }
  if (/^高新(?:园区|区|技术产业园区)$/.test(name)) {
    return { query: "大连高新技术产业园区管委会", approximate: true };
  }
}

function normalizeAddress(text: string) {
  return text.normalize("NFKC").replace(/([零〇一二两三四五六七八九十百千]+)(?=号)/g, (value) => {
    const digits = value.replace(/〇/g, "零").replace(/两/g, "二");
    if (!/[十百千]/.test(digits)) return Array.from(digits, (digit) => spokenDigits.indexOf(digit)).join("");
    let total = 0;
    let digit = 0;
    for (const character of digits) {
      const unit = { 十: 10, 百: 100, 千: 1000 }[character];
      if (unit) {
        total += (digit || 1) * unit;
        digit = 0;
      } else {
        digit = spokenDigits.indexOf(character);
      }
    }
    return String(total + digit);
  });
}

function splitCity(query: string) {
  return query.match(cityPrefix) ?? query.match(knownCityPrefix);
}

async function cityBounds(cityName: string, signal: AbortSignal): Promise<SearchBounds | undefined> {
  const city = cityName.endsWith("市") ? cityName : `${cityName}市`;
  const features = await searchPhoton(city, signal);
  for (const { properties } of features) {
    const extent = properties?.extent;
    if (properties?.name === city && ["county", "city", "state"].includes(String(properties.type)) &&
        Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite)) {
      const [west, north, east, south] = extent;
      return [west, south, east, north];
    }
  }
}

function matchingPlace(query: string, features: PlaceFeature[], city: string, options: {
  streetOnly?: boolean; districtHint?: string; precise?: boolean; requireCity?: boolean;
} = {}): Place | null {
  const { streetOnly = false, districtHint = "", precise = false, requireCity = false } = options;
  const prefix = compact(city.replace(/市$/, ""));
  const local = (name: string) => prefix && name.startsWith(prefix)
    ? name.slice(prefix.length).replace(/^市/, "") : name;
  const input = local(compact(query));
  const matches = features.flatMap(({ geometry, properties = {} }) => {
    const point = geometry?.coordinates;
    const { name, city: locality, county, district, state, country, street, housenumber, type, osm_value: kind } = properties;
    if (!isPoint(point) || (streetOnly && type !== "street")) return [];
    if (districtHint && ![locality, county, district].includes(districtHint)) return [];
    if (requireCity && ![locality, county, state].some(value =>
      typeof value === "string" && compact(value.replace(/市$/, "")) === prefix)) return [];
    const area = [...new Set([country, state, city, locality, district].filter(Boolean))].join(" · ");
    const label = typeof name === "string" && name ? name : "";
    const canonical = compact(label);
    const withoutCity = local(canonical);
    const address = typeof street === "string" && typeof housenumber === "string"
      ? compact(street + housenumber.replace(/号$/, "") + "号") : "";
    const landmark = withoutCity.replace(/(?:国际机场|机场)$/, "");
    const spokenLandmark = input.replace(/(?:国际机场|机场)$/, "");
    const airportAlias = kind === "aerodrome" &&
      ((spokenLandmark.length >= 3 && spokenLandmark === landmark) || (city && /^(?:国际)?机场$/.test(input)));
    const preferredKind = (type === "county" && /[市区县]$/.test(input)) ||
      (kind === "square" && input.endsWith("广场"));
    const shortName = input.length >= 2 && withoutCity !== input && withoutCity.replace(placeSuffix, "") === input;
    const station = ["station", "train_station", "bus_stop", "tram_stop", "motorway_junction"].includes(String(kind));
    const shoppingCenter = ["retail", "mall", "department_store"].includes(String(kind));
    const score = input === canonical || input === address || input === withoutCity
      ? (preferredKind ? 5 : type === "street" && /(?:路|街|道|巷)$/.test(input) ? 4 : station ? 2 : 3)
      : airportAlias || (shortName && !station) ? 1 : 0;
    const resolvedCity = city || [county, locality, label].find((value): value is string =>
      typeof value === "string" && value.endsWith("市"));
    const approximate = streetOnly || (areaTypes.has(String(type)) && kind !== "retail");
    const displayName = address && input === address && ![canonical, withoutCity].includes(input)
      ? query : label || query;
    return score ? [{ point, name: displayName, area, city: resolvedCity, approximate, score, street: type === "street", station, shoppingCenter }] : [];
  }).sort((a, b) => b.score - a.score);
  // A shopping center and its similarly named bus stops are one destination.
  const candidates = /(?:广场|购物中心|商场)$/.test(input) && matches.some(place => place.shoppingCenter)
    ? matches.filter(place => !place.station) : matches;
  const first = candidates[0];
  if (!first || (precise && first.approximate)) return null;
  const sameRank = candidates.filter((place) => precise ? !place.approximate : place.score === first.score);
  const nearby = precise ? .00015 : first.street && city && sameRank.every((place) => place.street) ? .016 : .002;
  if (sameRank.some(({ point }) => Math.hypot(point[0] - first.point[0], point[1] - first.point[1]) >= nearby)) return null;
  return { point: first.point, name: first.name, area: first.area, city: first.city, approximate: first.approximate };
}

export async function resolveMapPlaces(intent: { origin?: string; destination: string; route?: boolean }, signal: AbortSignal, defaultCity = "") {
  const precise = Boolean(intent.route || intent.origin);
  if (precise && !intent.origin?.trim()) throw new PlaceNotFoundError("", "origin", true);
  const clean = (query: string) => normalizeAddress(query).trim()
    .replace(nearbySuffix, "").replace(/的$/, "").trim();
  const originQuery = intent.origin ? clean(intent.origin) : "";
  const destinationQuery = clean(intent.destination);
  const originPrefix = splitCity(originQuery);
  const destinationPrefix = splitCity(destinationQuery);
  const sharedCity = originPrefix?.[1] ?? destinationPrefix?.[1] ?? defaultCity;
  const boundsByCity = new Map<string, Promise<SearchBounds | undefined>>();
  async function resolve(query: string, field: "origin" | "destination", prefix: RegExpMatchArray | null): Promise<Place> {
    const original = (field === "origin" ? intent.origin : intent.destination)?.trim() ?? "";
    const missing = () => new PlaceNotFoundError(original, field, precise);
    if (!query) throw missing();
    if (/^\s*-?\d+(?:\.\d+)?\s*[,，]\s*-?\d+(?:\.\d+)?\s*$/.test(query)) {
      const point = query.split(/[,，]/).map(Number);
      if (!isPoint(point)) throw missing();
      return { point, name: query, area: "" };
    }
    const standaloneCity = query.match(/^(?:大连|北京|上海|广州|深圳|杭州|南京|成都|重庆|西安|苏州|武汉|天津)市?$/)?.[0];
    const city = standaloneCity ? "" : prefix?.[1] ?? sharedCity;
    const localName = prefix ? prefix[2].replace(/^的/, "").trim() : query;
    if (city.replace(/市$/, "") === "大连" && /^万达(?:广场)?$/.test(localName)) {
      const label = field === "origin" ? "你想从大连哪家万达出发？" : "你说的是大连哪家万达？";
      throw new PlaceNotFoundError(original, field, precise,
        `${label}比如高新万达、甘井子万达，也可以说其他分店。`);
    }
    const fullName = prefix || !city ? query : city.replace(/市$/, "") + query;
    const qualified = localName.match(/^([\p{Script=Han}]{2,8}?(?:区|县|街道))[\s，,的]*(.+)$/u);
    const alias = dalianAlias(localName, city);
    let bounds: SearchBounds | undefined;
    if (city) {
      const key = city.replace(/市$/, "");
      if (!boundsByCity.has(key)) boundsByCity.set(key, cityBounds(city, signal));
      bounds = await boundsByCity.get(key);
    }
    const options = { precise, requireCity: Boolean(precise && city && !bounds) };
    let match: Place | null = null;
    if (alias && !(precise && alias.approximate)) {
      match = matchingPlace(alias.query, await searchPhoton(alias.query, signal, bounds), city, options);
      if (match && alias.approximate) match.approximate = true;
    }
    if (!match) {
      const searches = new Set(bounds ? [localName, fullName] : [fullName]);
      if (/[^际]机场$/.test(localName) && localName.length > 3) searches.add(fullName.replace(/机场$/, "国际机场"));
      for (const search of searches) {
        match = matchingPlace(localName, await searchPhoton(search, signal, bounds), city, options);
        if (match) break;
      }
    }
    const [districtHint, placeName] = qualified && !/(?:小区|社区|园区|景区)$/.test(qualified[1])
      ? [qualified[1], qualified[2]] : ["", localName];
    if (!match && districtHint) {
      match = matchingPlace(placeName, await searchPhoton(placeName, signal, bounds), city, { ...options, districtHint });
    }
    const street = placeName.match(/^(.+(?:路|街|道|巷|弄))\s*\d+(?:[-之]\d+)?号(?:.*)?$/)?.[1];
    if (!match && street && !precise) {
      match = matchingPlace(street, await searchPhoton(street, signal, bounds), city, { streetOnly: true, districtHint });
    }
    if (!match && !precise && city && !originPrefix && !destinationPrefix && !alias) {
      match = matchingPlace(query, await searchPhoton(query, signal), "");
    }
    if (!match) throw missing();
    return { ...match, approximate: match.approximate || (!precise && nearbySuffix.test(original)) };
  }
  const [origin, destination] = await Promise.all([
    intent.origin ? resolve(originQuery, "origin", originPrefix) : null,
    resolve(destinationQuery, "destination", destinationPrefix),
  ]);
  return { origin, destination };
}

function world([lng, lat]: Point): Point {
  return [(lng + 180) / 360, .5 - Math.asinh(Math.tan(lat * Math.PI / 180)) / (2 * Math.PI)];
}

async function drivingRoute(from: Place, to: Place, signal: AbortSignal) {
  const coordinates = `${from.point.join(",")};${to.point.join(",")}`;
  const response: { routes?: { distance: number; duration: number; geometry: { coordinates: Point[] } }[] } =
    await (await request(
      `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordinates}?overview=full&geometries=geojson`, signal,
    )).json();
  const route = response.routes?.[0];
  if (!route || route.geometry.coordinates.length < 2) throw new Error("没有找到可用的驾车路线。");
  return route;
}

function tileLayerFeatures(layer: VectorTileLayer | undefined) {
  return layer ? Array.from({ length: layer.length }, (_, i) => layer.feature(i)) : [];
}

export async function loadLiveScene(from: Place | null, to: Place, signal: AbortSignal): Promise<CityScene> {
  const plan = from ? await drivingRoute(from, to, signal) : null;
  const routeWorld = (plan?.geometry.coordinates ?? [to.point]).map(world);
  const target = world(to.point);
  // Unwrap around the destination so areas near ±180° don't span the globe.
  const unwrap = ([x, y]: Point): Point => [x - Math.round(x - target[0]), y];
  const unwrapped = routeWorld.map(unwrap);
  const start = from ? unwrap(world(from.point)) : null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of start ? [...unwrapped, start, target] : unwrapped) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const center: Point = [(minX + maxX) / 2, (minY + maxY) / 2];
  const metersPerWorld = 40075017 * Math.cos(to.point[1] * Math.PI / 180);
  const half = Math.max(1400 / metersPerWorld, Math.max(maxX - minX, maxY - minY) * .74);
  let zoom = 14;
  const bounds = () => {
    const n = 2 ** zoom;
    return [
      Math.floor((center[0] - half) * n), Math.max(0, Math.floor((center[1] - half) * n)),
      Math.floor((center[0] + half) * n), Math.min(n - 1, Math.floor((center[1] + half) * n)),
    ];
  };
  let [left, top, right, bottom] = bounds();
  while ((right - left + 1) * (bottom - top + 1) > 16 && zoom > 1) {
    zoom--;
    [left, top, right, bottom] = bounds();
  }

  const tilejson: { tiles?: string[] } = await (await request("https://tiles.openfreemap.org/planet", signal)).json();
  const template = tilejson.tiles?.[0];
  if (!template?.startsWith("https://tiles.openfreemap.org/")) throw new Error("无法取得地图瓦片地址。");
  const scale = 6.9 / half;
  const project = (x: number, y: number): Point => [(x - center[0]) * scale, (y - center[1]) * scale];
  const scene: CityScene = {
    localRoads: [], mainRoads: [], water: [], buildings: [],
    route: unwrapped.map(([x, y]) => project(x, y)),
    originPoint: start ? project(...start) : null,
    destinationPoint: project(...target),
    distanceMeters: plan?.distance ?? 0, durationSeconds: plan?.duration ?? 0,
  };
  const n = 2 ** zoom;
  const tiles: Point[] = [];
  for (let x = left; x <= right; x++) {
    for (let y = top; y <= bottom; y++) tiles.push([x, y]);
  }
  const intersectsScene = (path: Point[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of path) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return minX <= 6.9 && maxX >= -6.9 && minY <= 6.9 && maxY >= -6.9;
  };
  // Keep at most four concurrent downloads.
  for (let i = 0; i < tiles.length; i += 4) {
    const batch = await Promise.all(tiles.slice(i, i + 4).map(async ([x, y]) => {
      const url = template.replace("{z}", String(zoom)).replace("{x}", String((x % n + n) % n)).replace("{y}", String(y));
      const response = await request(url, signal);
      return { x, y, tile: new VectorTile(new PbfReader(await response.arrayBuffer())) };
    }));
    for (const { x, y, tile } of batch) {
      for (const feature of tileLayerFeatures(tile.layers.transportation)) {
        const kind = String(feature.properties.class);
        const group = roadClasses.has(kind) ? scene.mainRoads : localClasses.has(kind) ? scene.localRoads : null;
        if (!group || feature.type !== 2) continue;
        for (const line of feature.loadGeometry()) {
          const path = line.map((p) => project((x + p.x / feature.extent) / n, (y + p.y / feature.extent) / n));
          if (path.length > 1 && intersectsScene(path)) group.push(path);
        }
      }
      for (const name of ["building", "water"] as const) {
        for (const feature of tileLayerFeatures(tile.layers[name])) {
          if (feature.type !== 3) continue;
          for (const [outline] of classifyRings(feature.loadGeometry())) {
            const path = outline.map((p) => project((x + p.x / feature.extent) / n, (y + p.y / feature.extent) / n));
            if (!intersectsScene(path)) continue;
            if (name === "water") scene.water.push(path);
            else scene.buildings.push({ heightMeters: Number(feature.properties.render_height) || 5, outline: path });
          }
        }
      }
    }
  }
  if (!scene.mainRoads.length && !scene.localRoads.length) throw new Error("所选区域没有可用的街道数据，请换一个地点。");
  return scene;
}
