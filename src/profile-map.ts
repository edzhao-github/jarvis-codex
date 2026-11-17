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

export type ProfileQuestion = "company-address" | "company-name" | "work-hours" | "drinks" | "user-name" | "cats" | "dogs" | "pets";

export function profileSection(question: ProfileQuestion) {
  if (question === "drinks") return "preferences";
  if (question === "user-name") return "about";
  if (question === "cats" || question === "dogs" || question === "pets") return "pets";
  return "work";
}

export function profileQuestion(text: string): ProfileQuestion | null {
  const question = text.trim()
    .replace(/^(?:(?:嗨|嘿)[，, ]*)?(?:Jarvis|贾维斯|喵维斯)[，,、：:\s]*/i, "")
    .replace(/^(?:我们|我)?(?:来)?(?:测试|试)(?:一下|一些内容)?[，,。：:\s]+/, "")
    .replace(/^(?:请问|你知道|你还记得)[，,\s]*/, "")
    .replace(/(?:吗|呢)?[。！？?!\s]*$/, "");
  const company = /^(?:我|我们)(?:的)?公司(?:地址)?(?:是(?:在)?)?(?:在哪(?:里|儿)?|哪里|哪儿|在什么地方|地址是什么)$/;
  if (company.test(question) || /^(?:我|我们)(?:的)?公司地址(?:是)?什么$/.test(question)) return "company-address";
  if (/^(?:我|我们)(?:的)?公司(?:叫什么(?:名字)?|名称(?:是)?什么|名字(?:是)?什么)$/.test(question)) return "company-name";
  if (/^我(?:平时|一般|通常)?(?:几点(?:上班|下班|上班几点下班)|的?上班时间(?:是)?(?:几点|什么))$/.test(question)) return "work-hours";
  if (/^我(?:平时|一般|通常)?喜欢喝什么(?:饮品|饮料)?$/.test(question)) return "drinks";
  if (/^我(?:是谁|叫(?:什么(?:名字)?|啥)|(?:的)?(?:名字|姓名)(?:是)?(?:什么|啥))$/.test(question)) return "user-name";
  const pet = question.match(/^(?:我们?|咱们)(?:的|家(?:的)?|养的)?(?:(?:那)?[一二两三四五六七八九十\d几]+只)?(猫咪?|狗狗?|宠物)(?:们)?(?:分别|都)?(?:叫(?:什么(?:名字)?|啥)|(?:的)?名字(?:(?:是)?(?:什么|啥))?)$/);
  if (pet) return pet[1].startsWith("猫") ? "cats" : pet[1].startsWith("狗") ? "dogs" : "pets";
  return null;
}

export function answerProfileQuestion(question: ProfileQuestion, profile: string | null): string {
  if (profile === null) return "当前工作目录里没有找到《用户档案.md》。";
  const name = field(profile, "公司名称");
  switch (question) {
    case "company-address": {
      const address = field(profile, "公司地址");
      return address ? `档案里记的是${name ? `${name}，地址是` : ""}${address}。`
        : "档案里还没有记录你的公司地址。";
    }
    case "company-name":
      return name ? `你的公司叫${name}。` : "档案里还没有记录你的公司名称。";
    case "work-hours": {
      const hours = field(profile, "上班时间");
      return hours ? `档案里记的上班时间是${hours}。` : "档案里还没有记录你的上班时间。";
    }
    case "drinks": {
      const preference = profile.match(/^\s*-\s*喜欢喝([^。\r\n（(]+)/m)?.[1].trim();
      return preference ? `你喜欢喝${preference}。` : "档案里还没有记录你喜欢喝什么。";
    }
    case "user-name": {
      const name = field(profile, "姓名") ?? field(profile, "名字");
      return name ? `档案里记的是${name}。` : "档案里还没有记录你的姓名。";
    }
    case "cats":
    case "dogs":
    case "pets": {
      const entries = profile.matchAll(/(?:^|[、，,；;。\n])\s*(?:-\s*)?(猫|狗)\s*[：:]?\s*([^、，,；;。\n（(]+)[（(][^）)\n]+[）)]/g);
      const animal = question === "cats" ? "猫" : question === "dogs" ? "狗" : "宠物";
      const names = Array.from(entries)
        .filter(([, species]) => question === "pets" || species.startsWith(animal))
        .map(([, , name]) => name.trim())
        .filter(Boolean);
      if (names.length === 0) return `档案里还没有记录你的${animal}名字。`;
      return `档案里记录的${animal}叫${names.join("、")}。`;
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
