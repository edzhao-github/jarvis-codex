
const icons = {
  command: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  research: '<circle cx="10.5" cy="10.5" r="5"/><path d="m14.5 14.5 4 4"/>',
  build: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 12h6m-3-3v6"/>',
  review: '<path d="m6 12 4 4 8-8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3"/>',
  view: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14m8-14v14"/>',
  cloud: '<path d="M6 18a4 4 0 1 1 1-7.9 5.5 5.5 0 0 1 10.5 1.4A3.3 3.3 0 1 1 18 18Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  rain: '<path d="M7 16H6a3 3 0 1 1 .6-6 5.5 5.5 0 0 1 10.5 1A2.5 2.5 0 1 1 18 16h-1m-6 1-2 4m6-4-2 4"/>',
};
export function icon(name: keyof typeof icons) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}

export const workers = [
  ["orchestrator", "CODEX", "command"],
  ["researcher", "RESEARCH", "research"],
  ["developer", "BUILDER", "build"],
  ["reviewer", "REVIEW", "review"],
] as const;

export const workspaceContext = (mapEnabled: boolean) => `
<aside class="context-rail" aria-label="天气和日程">
  <section class="weather">
    <h2 class="rail-title">${mapEnabled ? "天气与出行" : "天气"} <small>示例</small></h2>
    <div class="weather-now"><strong>15<sup>°C</sup></strong>${icon("cloud")}</div>
    <p>大连 · 多云 <span>湿度 54%</span></p>
    <div class="forecast">
      <div><span>今天</span>${icon("cloud")}<b>9° / 16°</b></div>
      <div><span>明天</span>${icon("sun")}<b>10° / 18°</b></div>
      <div><span>后天</span>${icon("rain")}<b>11° / 17°</b></div>
    </div>
    ${mapEnabled ? `<button class="route-trigger" id="open-city" type="button" aria-controls="city-view" aria-expanded="false">
      <span class="route-action route-open-label">打开路线 ›</span>
      <span class="route-preview">
      <span class="route-summary"><span><b id="route-title"></b><small id="route-distance"></small></span><strong id="route-time"><span></span><small> 分钟</small></strong></span>
      <canvas id="route-map" width="544" height="180" aria-hidden="true"></canvas>
      <span class="route-action">收起路线 <small>© OpenStreetMap</small></span>
      </span>
    </button>` : ""}
  </section>
  <section class="agenda">
    <h2 class="rail-title">今日安排 <small>示例</small></h2>
    <ol>
      <li><time>09:30</time><b>查看工作进度</b></li>
      <li><time>14:00</time><b>整理项目资料</b></li>
    </ol>
  </section>
</aside>`;

export const shortcuts = [
  ["工作进度", "总结一下今天的工作进度"],
  ["查看待办", "根据当前工作区和对话列出今天的待办事项"],
  ["拆解咖啡机", "拆解一下咖啡机"],
] as const;

const TAU = Math.PI * 2;
const ribbonCount = 6;
const steps = 144;

export function mountOrb(canvas: HTMLCanvasElement, readState: () => { mode: string; level: number }, voiceInUse: () => boolean) {
  const ctx = canvas.getContext("2d")!;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const stars = Array.from({ length: 275 }, (_, index) => {
    const fraction = (value: number) => value - Math.floor(value);
    return [fraction(index * .6180339), fraction(index * .7548777), fraction(index * .5698403)];
  });
  const coordinates = new Float32Array((steps + 1) * 2);
  let width = 0;
  let height = 0;
  let previousFrame = -Infinity;
  new ResizeObserver(([entry]) => {
    ({ width, height } = entry.contentRect);
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    previousFrame = -Infinity;
  }).observe(canvas);

  function render(now: number) {
    requestAnimationFrame(render);
    const lightweight = voiceInUse();
    const frameInterval = reducedMotion.matches ? 250 : lightweight ? 67 : 28;
    if (!width || !height || document.hidden || now - previousFrame < frameInterval) return;
    previousFrame = now;
    const { mode, level } = readState();
    const time = reducedMotion.matches ? 0 : now / 1000;
    const motion = mode === "working" ? .56 : .29;
    const radius = Math.min(width * .315, height * .365) * (1 + level * .09);
    const centerX = width / 2;
    const centerY = height * .49;
    const color = mode === "stopped" ? "252,112,105" : "100,202,255";
    const warm = mode === "working" ? "255,174,100" : "255,216,182";
    ctx.clearRect(0, 0, width, height);

    const aura = ctx.createRadialGradient(centerX, centerY, radius * .08, centerX, centerY, radius * 1.58);
    aura.addColorStop(0, `rgba(${color},.085)`);
    aura.addColorStop(.55, `rgba(${color},.055)`);
    aura.addColorStop(1, "transparent");
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, width, height);

    for (const [x, y, seed] of stars) {
      const px = x * width;
      const py = ((y + time * (.0015 + seed * .002)) % 1) * height;
      const fade = Math.max(0, 1 - Math.hypot((px - centerX) / (width * .53), (py - centerY) / (height * .63)));
      ctx.fillStyle = `rgba(${seed > .91 ? warm : color},${fade * (.18 + seed * .55)})`;
      ctx.fillRect(px, py, seed > .91 ? 2 : 1, seed > .94 ? 3 : 1);
      if (seed > .9) {
        ctx.fillStyle = `rgba(${color},${fade * .08})`;
        ctx.fillRect(px, py - height * .19, 1, height * .19);
      }
    }

    ctx.save();
    ctx.translate(centerX, centerY);
    for (let index = 0; index < 5; index++) {
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * (1.16 + index * .07), radius * (.48 + index * .08), -.68 + index * .33, 0, TAU);
      ctx.strokeStyle = `rgba(${index % 3 ? color : warm},.22)`;
      ctx.lineWidth = .7;
      ctx.setLineDash(index === 3 ? [2, 5] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = "lighter";

    const strandCount = lightweight ? 12 : 34;
    const pathSteps = lightweight ? 72 : steps;
    for (let ribbon = 0; ribbon < ribbonCount; ribbon++) {
      const phase = ribbon * 2.39;
      const turn = time * motion * (ribbon % 2 ? 1 : -.78) + phase;
      const tilt = phase + .46 * Math.sin(time * .21 + phase);
      const pitch = .79 + ribbon * .39;
      const ribbonColor = ribbon % 3 === 1 ? warm : color;
      const cosTilt = Math.cos(tilt);
      const sinTilt = Math.sin(tilt);
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);

      // Closely spaced strands form a translucent ribbon with brighter edges.
      for (let strand = 0; strand < strandCount; strand++) {
        const band = (strand / (strandCount - 1) - .5) * .36;
        ctx.beginPath();
        for (let step = 0; step <= pathSteps; step++) {
          const angle = step / pathSteps * TAU;
          const latitude = .49 * Math.sin(3 * angle + turn) + band;
          const ripple = 1 + .1 * Math.sin(4 * angle - turn * .86) + .055 * Math.cos(2 * angle + phase);
          const x = Math.cos(angle) * Math.cos(latitude) * ripple;
          const y = Math.sin(angle) * Math.cos(latitude) * ripple;
          const z = Math.sin(latitude);
          const tiltedY = y * cosPitch - z * sinPitch;
          const depth = y * sinPitch + z * cosPitch;
          const perspective = 1 / (1 - depth * .16);
          const px = (x * cosTilt - tiltedY * sinTilt) * radius * perspective;
          const py = (x * sinTilt + tiltedY * cosTilt) * radius * perspective * .94;
          coordinates[step * 2] = px;
          coordinates[step * 2 + 1] = py;
          if (step === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        const edge = strand === 0 || strand === strandCount - 1;
        ctx.lineWidth = edge ? 1.3 : .78;
        ctx.strokeStyle = `rgba(${ribbonColor},${edge ? .36 : (lightweight ? .21 : .115) + level * .05})`;
        if (edge && !lightweight) {
          ctx.shadowColor = `rgb(${ribbonColor})`;
          ctx.shadowBlur = 10 + level * 7;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      ctx.fillStyle = `rgba(${ribbonColor},.65)`;
      for (let dot = 0; dot < 9; dot++) {
        const step = Math.floor((dot * 17 + time * 11 + ribbon * 23) % pathSteps);
        ctx.fillRect(coordinates[step * 2], coordinates[step * 2 + 1], 1.4, 1.4);
      }
    }
    ctx.restore();
  }
  requestAnimationFrame(render);
}
