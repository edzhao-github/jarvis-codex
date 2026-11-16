import type { CityScene, Place } from "./live-city-data";
import type { MapIntent } from "./map-intent";

export function mountCitySearch(
  showScene: (scene: CityScene, origin: Place | null, destination: Place) => void,
  reportStatus: (message: string, failed?: boolean, missing?: "origin" | "destination") => void,
) {
  let active: AbortController | null = null;
  let input: MapIntent = { destination: "" };

  function close() {
    const operation = active;
    active = null;
    operation?.abort();
  }

  async function show(intent: MapIntent, defaultCity: string) {
    close();
    input = intent;
    const operation = new AbortController();
    active = operation;
    const deadline = window.setTimeout(() => operation.abort(new DOMException("地图请求超时", "TimeoutError")), 20_000);
    reportStatus("正在查找地点…");
    try {
      const { resolveMapPlaces, loadLiveScene } = await import("./live-city-data");
      const { origin, destination } = await resolveMapPlaces(intent, operation.signal, defaultCity);

      operation.signal.throwIfAborted();
      reportStatus(origin ? "正在规划路线并加载街区…" : "正在加载真实街区…");
      const scene = await loadLiveScene(origin, destination, operation.signal);
      operation.signal.throwIfAborted();
      showScene(scene, origin, destination);
    } catch (error) {
      if (active !== operation) return;
      const detail: unknown = operation.signal.aborted ? operation.signal.reason : error;
      const field = detail && typeof detail === "object" && "field" in detail ? detail.field : null;
      if (detail instanceof Error && (field === "origin" || field === "destination")) {
        reportStatus(detail.message, true, field);
      } else if (detail instanceof Error && detail.name === "TimeoutError") {
        reportStatus("地图服务响应超时，请重试。", true);
      } else {
        reportStatus(detail instanceof Error && detail.name !== "TypeError"
          ? detail.message : "无法连接地图服务，请稍后重试。", true);
      }
    } finally {
      window.clearTimeout(deadline);
      if (active === operation) active = null;
    }
  }

  return { close, show, input: () => input };
}
