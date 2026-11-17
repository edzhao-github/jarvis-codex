export const systemStatsMarkup = `
  <dl class="system-stats" aria-label="本机系统指标">
    <div title="CPU 总使用率"><dt>CPU</dt><dd id="stat-cpu">—</dd></div>
    <div title="已使用内存 / 物理内存（不含可回收文件缓存）"><dt>MEM</dt><dd id="stat-memory">—</dd></div>
    <div class="network-stat" title="网络下载 / 上传速率"><dt>NET</dt><dd id="stat-network">—</dd></div>
    <div title="电池电量 · 闪电表示接入电源"><dt>BAT</dt><dd id="stat-battery">—</dd></div>
  </dl>`;

type SystemStats = {
  cpuPercent: number | null;
  memoryPercent: number | null;
  receivedBytes: number | null;
  sentBytes: number | null;
  batteryPercent: number | null;
  pluggedIn: boolean;
};

function rate(bytes: number) {
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
}

export function mountSystemStats(read: (() => Promise<SystemStats>) | null, voiceInUse: () => boolean) {
  const cpu = document.querySelector<HTMLElement>("#stat-cpu")!;
  const memory = document.querySelector<HTMLElement>("#stat-memory")!;
  const network = document.querySelector<HTMLElement>("#stat-network")!;
  const battery = document.querySelector<HTMLElement>("#stat-battery")!;
  if (!read) {
    cpu.textContent = "18%";
    memory.textContent = "53%";
    network.textContent = "↓ 84.0 KB/s ↑ 12.0 KB/s";
    battery.textContent = "76%";
    document.querySelector(".system-stats")?.setAttribute("aria-label", "系统指标示例");
    return;
  }

  const percent = (value: number | null) => value === null ? "—" : `${Math.round(value)}%`;
  let previous: { received: number; sent: number; time: number } | undefined;
  const sample = read;

  async function refresh() {
    try {
      if (voiceInUse() || document.hidden || document.querySelector(".shell")?.getAttribute("data-view") !== "workspace") {
        previous = undefined;
        return;
      }

      const sampleTime = performance.now();
      const stats = await sample();
      cpu.textContent = percent(stats.cpuPercent);
      memory.textContent = percent(stats.memoryPercent);
      battery.textContent = stats.batteryPercent === null && stats.pluggedIn
        ? "AC"
        : percent(stats.batteryPercent) + (stats.batteryPercent !== null && stats.pluggedIn ? " ⚡" : "");

      const { receivedBytes, sentBytes } = stats;
      if (receivedBytes === null || sentBytes === null) {
        previous = undefined;
        network.textContent = "—";
        return;
      }

      const elapsed = previous ? (sampleTime - previous.time) / 1000 : 0;
      network.textContent = previous && elapsed > 0 && receivedBytes >= previous.received && sentBytes >= previous.sent
        ? `↓ ${rate((receivedBytes - previous.received) / elapsed)} ↑ ${rate((sentBytes - previous.sent) / elapsed)}`
        : "—";
      previous = { received: receivedBytes, sent: sentBytes, time: sampleTime };
    } catch {
      for (const field of [cpu, memory, network, battery]) field.textContent = "—";
      previous = undefined;
    } finally {
      window.setTimeout(refresh, 4000);
    }
  }

  void refresh();
}
