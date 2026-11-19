import type { MapIntent } from "./map-intent";

// Only known address fields are used. No profile prose is sent to geocoders.
function field(profile: string, name: string): string | undefined {
  for (const line of profile.split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*([^：:]+)[：:]\s*(.+)$/);
    if (match?.[1].trim() === name) {
      return match[2].split(/(?:[。；;]|[（(])/)[0].trim() || undefined;
    }
  }
}

export const DEFAULT_PROFILE_ORIGIN = "档案默认起点";

export function resolveProfileMap(intent: MapIntent, profile: string | null): MapIntent {
  profile ??= "";
  const company = field(profile, "公司地址");
  const companyName = field(profile, "公司名称");
  const home = field(profile, "居住小区");
  const savedOrigin = field(profile, "出行默认起点");
  const defaultOrigin = savedOrigin?.includes("上述居住小区") ? home : savedOrigin;
  const origin = intent.origin === DEFAULT_PROFILE_ORIGIN ? defaultOrigin : intent.origin;
  const resolve = (place: string): string => {
    if (/^(?:我|我们)?(?:的)?公司$/.test(place.trim()) && company) {
      return [company, companyName].filter(Boolean).join(" ");
    }
    if (/^(?:我|我们)?(?:的)?家$/.test(place.trim()) && home) return home;
    return place;
  };
  // A schedule is not GPS. Never silently replace an explicit origin with a guess.
  return {
    ...intent,
    destination: resolve(intent.destination),
    ...(intent.origin === DEFAULT_PROFILE_ORIGIN ? { route: true, origin: origin && resolve(origin) }
      : origin ? { origin: resolve(origin) } : {}),
  };
}
