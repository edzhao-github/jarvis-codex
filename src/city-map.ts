import type { CityScene, Point } from "./live-city-data";

type Path = number[][];
const attribution = '<button class="map-attribution" id="city-source" type="button" aria-expanded="false" aria-controls="city-source-details">© OpenStreetMap</button>';

export const cityMapMarkup = `
  <section id="city-view" class="city-view" aria-label="全息地图" hidden>
    <div class="city-toolbar">
      <button id="close-city" type="button">‹ 返回核心</button>
      <span id="city-location" class="city-location"></span>
      <button id="orbit-city" type="button" aria-pressed="false">自动环绕</button>
      <button id="reset-city" type="button">重置视角</button>
    </div>
    <canvas id="city-canvas" aria-hidden="true"></canvas>
    <span id="city-start" class="city-pin"></span>
    <span id="city-end" class="city-pin city-destination"></span>
    <div class="city-caption">
      <strong id="city-title"></strong><span id="city-distance"></span>
      <small>拖动旋转 · 滚动缩放</small>
    </div>
    ${attribution}
    <div id="city-source-details" class="city-source-details" hidden>
      © OpenStreetMap contributors · ODbL<br>
      底图：OpenFreeMap / © OpenMapTiles<br>
      路线：OSRM · 未计实时路况<br>
      地点检索：Photon
    </div>
  </section>`;

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const fraction = (value: number) => value - Math.floor(value);

function trace(ctx: CanvasRenderingContext2D, paths: Path[], project: (x: number, y: number) => Point) {
  ctx.beginPath();
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const [x, y] = project(path[i][0], path[i][1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

export function drawRoute(canvas: HTMLCanvasElement, scene: CityScene) {
  const { localRoads, mainRoads, route } = scene;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const angle = -.94;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const project = (x: number, y: number): Point => [
    canvas.width * .53 + (x * cos - y * sin) * 31,
    canvas.height * .50 + (x * sin + y * cos) * 16,
  ];
  trace(ctx, localRoads, project);
  ctx.strokeStyle = "#20394f";
  ctx.lineWidth = 1;
  ctx.stroke();
  trace(ctx, mainRoads, project);
  ctx.strokeStyle = "#3a6982";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  trace(ctx, [route], project);
  ctx.shadowColor = "#f6a657";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "#ffd092";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (route.length > 1) dot(ctx, ...project(...route[0]), 6, "#91e5ff");
  dot(ctx, ...project(...route[route.length - 1]), 6, "#ffca89");
}

function measureRoute(route: Point[]) {
  const distances = [0];
  for (let i = 1; i < route.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
  }
  return distances;
}

function routePoint(route: Point[], distances: number[], distance: number): Point {
  const next = distances.findIndex((value) => value >= distance);
  if (next <= 0) return route[0];
  const t = (distance - distances[next - 1]) / (distances[next] - distances[next - 1]);
  const [x, y] = route[next - 1];
  return [x + (route[next][0] - x) * t, y + (route[next][1] - y) * t];
}

function prepareScene(scene: CityScene) {
  // Outline the largest buildings in 3D while drawing every footprint on the ground.
  const skyline = scene.buildings.map(({ outline, heightMeters }) => ({
    outline,
    heightMeters,
    area: Math.abs(outline.slice(1).reduce((sum, [x, y], i) => sum + outline[i][0] * y - outline[i][1] * x, 0)),
  })).sort((a, b) => b.area * Math.sqrt(b.heightMeters) - a.area * Math.sqrt(a.heightMeters)).slice(0, 340);
  return { ...scene, skyline, footprints: scene.buildings.map(({ outline }) => outline), distances: measureRoute(scene.route) };
}

const lights = Array.from({ length: 155 }, (_, i) => ({
  x: (fraction(i * .6180339 + .31) - .5) * 15,
  y: (fraction(i * .7548777 + .48) - .5) * 15,
  z: fraction(i * .5698403 + .61),
  phase: fraction(i * .41421356 + .23) * TAU,
}));

export function mountCityMap(canvas: HTMLCanvasElement, start: HTMLElement, end: HTMLElement, orbit: HTMLButtonElement) {
  const ctx = canvas.getContext("2d")!;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let yaw = -.55;
  let tilt = .44;
  let zoom = 1;
  let opened: number | null = null;
  let orbitTime = 0;
  let previousFrame = 0;
  let rotating = false;
  let frame = 0;
  let pointer: { id: number; x: number; y: number } | null = null;
  let background: CanvasGradient;
  let scene: ReturnType<typeof prepareScene> | null = null;

  function render(now: number) {
    frame = 0;
    if (!scene || !width || !height || opened === null) return;
    const { localRoads, mainRoads, water, skyline, footprints, route, distances } = scene;
    const elapsed = reducedMotion.matches ? 1800 : now - opened;
    if (rotating) {
      const dt = clamp((now - previousFrame) / 1000, 0, .05);
      orbitTime += dt;
      yaw += dt * .24;
      tilt = .51 + .18 * Math.sin(orbitTime * .57 - .4);
    }
    previousFrame = now;
    const scale = Math.min(width / 15.6, height / 11.8) * zoom;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const rise = Math.sqrt(1 - tilt ** 2);
    function project(x: number, y: number, z = 0): Point {
      const depth = x * sin + y * cos;
      const perspective = 1 / (1 - depth * .028 + z * .015);
      return [width * .5 + (x * cos - y * sin) * scale * perspective,
        height * .54 + (depth * tilt - z * rise) * scale * perspective];
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    trace(ctx, water, project);
    ctx.fillStyle = "#163f55a0";
    ctx.fill();
    ctx.strokeStyle = "#55a2b64f";
    ctx.lineWidth = .65;
    ctx.stroke();

    trace(ctx, footprints, project);
    ctx.fillStyle = "#19416190";
    ctx.fill();
    trace(ctx, localRoads, project);
    ctx.strokeStyle = "#4a9aba61";
    ctx.lineWidth = .7;
    ctx.stroke();
    trace(ctx, mainRoads, project);
    ctx.strokeStyle = "#28a6dd2b";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = "#a4ebffbd";
    ctx.lineWidth = 1.15;
    ctx.stroke();

    const growth = 1 - (1 - clamp(elapsed / 1000, 0, 1)) ** 3;
    ctx.beginPath();
    for (const { outline, heightMeters } of skyline) {
      const z = clamp(heightMeters / 91, .09, 1.85) * growth;
      for (let i = 0; i < outline.length; i++) {
        const [x, y] = outline[i];
        const [rx, ry] = project(x, y, z);
        if (!i) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      }
      for (let i = 0; i < outline.length - 1; i++) {
        const [x, y] = outline[i];
        ctx.moveTo(...project(x, y));
        ctx.lineTo(...project(x, y, z));
      }
    }
    ctx.strokeStyle = "#82d9fa91";
    ctx.lineWidth = .68;
    ctx.stroke();

    // Suspended particles use world coordinates so they turn with the city.
    for (const [i, light] of lights.entries()) {
      const { x, y, z, phase } = light;
      const [px, py] = project(x, y, .12 + z * (2.5 + .24 * Math.sin(elapsed * .0012 + phase)));
      const bright = i % 21 === 0;
      if (bright) {
        ctx.beginPath();
        ctx.moveTo(...project(x, y));
        ctx.lineTo(px, py);
        ctx.strokeStyle = "#70d6f32c";
        ctx.lineWidth = .65;
        ctx.stroke();
        dot(ctx, px, py, 5, "#66dfff29");
      }
      dot(ctx, px, py, bright ? 1.65 : .65, bright ? "#a0eeff" : "#a8d9f276");
    }

    const progress = 1 - (1 - clamp(elapsed / 1600, 0, 1)) ** 3;
    const routeProject = (x: number, y: number) => project(x, y, .04);
    if (route.length > 1) {
      const routeLength = distances[distances.length - 1];
      const travelled = routeLength * progress;
      const visible = route.slice(0, distances.findIndex((value) => value > travelled));
      trace(ctx, [progress === 1 ? route : [...visible, routePoint(route, distances, travelled)]], routeProject);
      ctx.strokeStyle = "#f1933c38";
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.shadowColor = "#ffac50";
      ctx.shadowBlur = 14;
      ctx.strokeStyle = "#ffb764";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#fff1cb";
      ctx.lineWidth = 1.25;
      ctx.stroke();
      if (!reducedMotion.matches) {
        const [x, y] = routeProject(...routePoint(route, distances, rotating && progress === 1 ? (elapsed % 4800) / 4800 * routeLength : travelled));
        dot(ctx, x, y, 7, "#ffba5a55");
        dot(ctx, x, y, 2.6, "#fff4ce");
      }

    }

    for (const [index, label] of [start, end].entries()) {
      if (!index && route.length === 1) continue;
      const [x, y] = index ? route[route.length - 1] : route[0];
      const [groundX, groundY] = routeProject(x, y);
      const [labelX, labelY] = project(x, y, .55);
      const accent = index ? "#ffc480" : "#8ee7ff";
      ctx.beginPath();
      ctx.moveTo(groundX, groundY);
      ctx.lineTo(labelX, labelY - 10);
      ctx.strokeStyle = accent;
      ctx.lineWidth = .8;
      ctx.stroke();
      dot(ctx, groundX, groundY, 6, index ? "#ffc48046" : "#8ee7ff46");
      dot(ctx, groundX, groundY, 2.6, accent);
      label.style.left = `${labelX}px`;
      label.style.top = `${labelY}px`;
    }
    if (rotating || progress < 1) invalidate();
  }

  function invalidate() {
    if (opened !== null && !frame) frame = requestAnimationFrame(render);
  }

  function setOrbit(active: boolean) {
    rotating = active;
    previousFrame = performance.now();
    orbit.setAttribute("aria-pressed", String(active));
    invalidate();
  }
  orbit.addEventListener("click", () => setOrbit(!rotating));
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) setOrbit(false);
  });

  new ResizeObserver(([entry]) => {
    ({ width, height } = entry.contentRect);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    background = ctx.createRadialGradient(width / 2, height * .54, 0, width / 2, height * .54, Math.max(width, height) * .55);
    background.addColorStop(0, "#11324b");
    background.addColorStop(.63, "#0c2032ae");
    background.addColorStop(1, "#0a152500");
    invalidate();
  }).observe(canvas);

  canvas.addEventListener("pointerdown", (event) => {
    if (pointer || event.button !== 0) return;
    setOrbit(false);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(pointer.id);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (pointer?.id !== event.pointerId) return;
    yaw += (event.clientX - pointer.x) * .008;
    tilt = clamp(tilt + (event.clientY - pointer.y) * .005, .2, .92);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    invalidate();
  });
  canvas.addEventListener("lostpointercapture", () => { pointer = null; });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = clamp(zoom * Math.exp(-event.deltaY * .001), .68, 1.65);
    invalidate();
  }, { passive: false });

  function reset() {
    yaw = -.55;
    tilt = .44;
    zoom = 1;
    orbitTime = 0;
    invalidate();
  }

  return {
    setScene(data: CityScene, origin: string | null, destination: string) {
      scene = prepareScene(data);
      start.hidden = !origin;
      start.textContent = origin;
      end.textContent = destination;
      if (opened !== null) {
        opened = performance.now();
        reset();
      }
    },
    show() {
      opened = performance.now();
      reset();
      setOrbit(!reducedMotion.matches);
    },
    hide() {
      opened = null;
      pointer = null;
      cancelAnimationFrame(frame);
      frame = 0;
    },
    reset,
  };
}
