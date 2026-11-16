import models from "./data/anatomy.json";
import "./anatomy.css";

type Vec = number[];
type Path = Vec[];
const partColor = "#81c9ee";
const highlightColor = "#ffd69a";
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

export function anatomyRequest(text: string) {
  const prompt = text.trim().replace(/[。！!？?]+$/, "");
  return prompt.match(/^(?:(?:嘿|嗨|Hey)[，,、\s]*)?(?:(?:Jarvis|贾维斯|喵维斯)[，,、\s]*)?(?:请|麻烦)?\s*(?:帮我|给我)?\s*(?:拆解(?:一下)?|(?:打开|展示|看看|查看)(?:一下)?(?=.+(?:拆解|爆炸图)))[：:\s]*(.*?)(?:的?(?:拆解(?:演示)?|爆炸图))?$/i)?.[1]?.trim();
}

export const anatomyMarkup = `
<section class="anatomy-view" aria-label="拆解演示" hidden>
  <div class="anatomy-toolbar">
    <button type="button" data-close>‹ 返回核心</button>
    <div><h2></h2><span>结构示意</span></div>
    <button type="button" data-explode aria-pressed="false">展开</button>
  </div>
  <div class="anatomy-model">
    <canvas aria-label="可拖动旋转的三维线框模型"></canvas>
    <div class="anatomy-pins"></div>
    <small>拖动旋转 · 滚动缩放</small>
  </div>
  <div class="anatomy-detail" aria-live="polite"><strong></strong><p></p></div>
  <div class="anatomy-parts" role="group" aria-label="选择部件"></div>
</section>`;

function box(center: Vec, size: Vec): Path[] {
  const corners = Array.from({ length: 8 }, (_, index) => center.map((value, axis) =>
    value + size[axis] * (index & (1 << axis) ? .5 : -.5)));
  return corners.flatMap((point, index) => [1, 2, 4].filter(bit => !(index & bit))
    .map(bit => [point, corners[index | bit]]));
}

function geometry(kind: string, center: Vec, size: Vec): Path[] {
  if (kind === "keys") {
    return Array.from({length: 60}, (_, index) => {
      const column = index % 12;
      const row = Math.floor(index / 12);
      const stepX = size[0] / 12;
      const stepZ = size[2] / 5;
      return box([center[0] + (column - 5.5) * stepX, center[1], center[2] + (row - 2) * stepZ],
        [stepX * .80, size[1], stepZ * .81]);
    }).flat();
  }
  if (kind === "box") return box(center, size);
  const ring = (height: number) => Array.from({length: 25}, (_, index) => {
    const angle = index * Math.PI / 12;
    return [center[0] + Math.cos(angle) * size[0], height, center[2] + Math.sin(angle) * size[2]];
  });
  const top = ring(center[1] + size[1] / 2);
  const bottom = ring(center[1] - size[1] / 2);
  return [top, bottom, ...top.slice(0, 24).filter((_, index) => index % 3 === 0)
    .map((point, index) => [point, bottom[index * 3]])];
}

const scenes = models.map(model => ({
  ...model,
  parts: model.parts.map(part => ({
    ...part,
    paths: part.shapes.flatMap(([kind, center, size]) => geometry(kind as string, center as Vec, size as Vec)),
  })),
}));

export function mountAnatomy(root: HTMLElement, onClose: () => void) {
  const canvas = root.querySelector("canvas")!;
  const ctx = canvas.getContext("2d")!;
  const closeButton = root.querySelector<HTMLButtonElement>("[data-close]")!;
  const toggle = root.querySelector<HTMLButtonElement>("[data-explode]")!;
  const parts = root.querySelector(".anatomy-parts")!;
  const pins = root.querySelector(".anatomy-pins")!;
  const detail = root.querySelector(".anatomy-detail")!;
  let scene = scenes[0];
  let selected = -1;
  let expanded = false;
  let spread = 0;
  let yaw = -.32;
  let pitch = .24;
  let zoom = 1;
  let frame = 0;
  let lastFrame = 0;
  let pointer: { x: number; y: number; id: number } | null = null;

  function select(index: number) {
    selected = index;
    detail.querySelector("strong")!.textContent = scene.parts[index]?.name ?? "整机";
    detail.querySelector("p")!.textContent = scene.parts[index]?.detail ??
      (expanded ? scene.guide : "展开模型，或点选部件查看它的作用。");
    for (const group of [parts, pins]) {
      [...group.children].forEach((button, i) => button.setAttribute("aria-pressed", String(i === selected)));
    }
    requestDraw();
  }

  function requestDraw() {
    if (!root.hidden && !frame) frame = requestAnimationFrame(draw);
  }

  function draw(now: number) {
    frame = 0;
    const {width, height} = canvas.getBoundingClientRect();
    if (root.hidden || !width || !height) return;
    const ratio = Math.min(devicePixelRatio, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const target = Number(expanded);
    const step = Math.min(40, lastFrame ? now - lastFrame : 16) / 360;
    lastFrame = now;
    spread += Math.sign(target - spread) * Math.min(Math.abs(target - spread), step);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) spread = target;
    const eased = spread * spread * (3 - 2 * spread);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const projectToPlane = ([x, y, z]: Vec): [number, number] => {
      const depth = x * sy + z * cy;
      return [x * cy - z * sy, depth * sp - y * cp];
    };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const projectedParts = scene.parts.map(part => {
      const origin = part.center.map((value, axis) => value + eased * part.offset[axis]);
      const paths = part.paths.map(path => path.map(point => {
        const [x, y] = projectToPlane(point.map((value, axis) => value + origin[axis]));
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
        return [x, y];
      }));
      return { paths, anchor: projectToPlane(origin) };
    });
    const scale = Math.min(width * (1 - eased * .38) * .86 / (right - left), height * .79 / (bottom - top),
      Math.min(width, height) / (2.9 + eased * 1.2)) * zoom;
    const toScreen = ([x, y]: Vec): [number, number] => {
      return [width / 2 + (x - (left + right) / 2) * scale,
        height / 2 + (y - (top + bottom) / 2) * scale];
    };
    const project = (point: Vec) => toScreen(projectToPlane(point));

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    projectedParts.forEach((part, i) => {
      const source = scene.parts[i];
      if (!source.offset.some(Boolean) || (selected !== -1 && i !== selected)) return;
      ctx.moveTo(...project(source.center));
      ctx.lineTo(...toScreen(part.anchor));
    });
    ctx.globalAlpha = eased;
    ctx.strokeStyle = selected === -1 ? "#547388" : highlightColor;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const labels = projectedParts.map((part, i) => {
      const [x, y] = toScreen(part.anchor);
      const pin = pins.children[i] as HTMLButtonElement;
      pin.hidden = spread < .96 || height < 175 || width < 350;
      return { x, y, pin, i };
    });
    if (spread >= .96 && height >= 175 && width >= 350) {
      const byColumn = [
        labels.filter(label => label.x < width / 2),
        labels.filter(label => label.x >= width / 2),
      ];
      byColumn.forEach((column, side) => {
        column.sort((a, b) => a.y - b.y);
        const xEdge = side === 0 ? 8 : width - 8;
        const spacing = 27;
        let next = 16;
        column.forEach(({ x, y, pin, i }, rank) => {
          const labelY = Math.min(height - 22 - (column.length - 1 - rank) * spacing, Math.max(next, y));
          next = labelY + spacing;
          const end = xEdge + (side === 0 ? pin.offsetWidth : -pin.offsetWidth);
          pin.style.left = `${xEdge}px`;
          pin.style.top = `${labelY}px`;
          pin.style.transform = side === 0 ? "translateY(-50%)" : "translate(-100%, -50%)";
          ctx.strokeStyle = i === selected ? highlightColor : "#52798f";
          ctx.globalAlpha = selected === -1 || i === selected ? .8 : .27;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(end + (side === 0 ? 12 : -12), labelY);
          ctx.lineTo(end, labelY);
          ctx.stroke();
        });
      });
      ctx.globalAlpha = 1;
    }

    projectedParts.forEach((part, i) => {
      ctx.beginPath();
      for (const path of part.paths) {
        path.forEach((point, j) => {
          const [x, y] = toScreen(point);
          if (j) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
      }
      const fixed = !scene.parts[i].offset.some(Boolean);
      ctx.strokeStyle = i === selected ? highlightColor : partColor;
      ctx.globalAlpha = selected === -1 ? (fixed ? 1 - eased * .4 : .85) : i === selected ? 1 : .24;
      ctx.lineWidth = i === selected ? 1.65 : .9;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = i === selected ? 5 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });
    if (spread !== target) requestDraw();
    else lastFrame = 0;
  }

  function setExpanded(value: boolean) {
    expanded = value;
    toggle.textContent = expanded ? "复原" : "展开";
    toggle.setAttribute("aria-pressed", String(expanded));
    select(expanded ? selected : -1);
    requestDraw();
  }

  toggle.addEventListener("click", () => setExpanded(!expanded));
  closeButton.addEventListener("click", onClose);
  root.addEventListener("keydown", event => {
    if (event.key === "Escape") onClose();
  });
  canvas.addEventListener("pointerdown", event => {
    canvas.setPointerCapture(event.pointerId);
    pointer = {x: event.clientX, y: event.clientY, id: event.pointerId};
  });
  canvas.addEventListener("pointermove", event => {
    if (pointer?.id !== event.pointerId) return;
    yaw += (event.clientX - pointer.x) * .009;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + (event.clientY - pointer.y) * .009));
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    requestDraw();
  });
  canvas.addEventListener("lostpointercapture", () => { pointer = null; });
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    zoom = Math.min(1.8, Math.max(.65, zoom * Math.exp(-event.deltaY * .001)));
    requestDraw();
  }, {passive: false});
  new ResizeObserver(requestDraw).observe(canvas);

  return {
    open(query: string) {
      const match = scenes.find(model => model.aliases.some(alias => normalize(alias) === normalize(query)));
      if (!match) return null;
      scene = match;
      root.hidden = false;
      root.querySelector("h2")!.textContent = scene.name;
      yaw = -.32;
      pitch = .24;
      zoom = 1;
      spread = 0;
      for (const group of [parts, pins]) {
        group.replaceChildren(...scene.parts.map((part, i) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = part.name;
          button.hidden = group === pins;
          button.addEventListener("click", () => {
            setExpanded(true);
            select(i);
          });
          return button;
        }));
      }
      setExpanded(false);
      closeButton.focus();
      return scene.name;
    },
    close() {
      root.hidden = true;
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
    },
  };
}
