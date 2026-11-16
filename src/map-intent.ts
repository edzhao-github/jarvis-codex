export type MapIntent = { destination: string; origin?: string };

export function mapFollowUp(text: string) {
  if (/(?:^|[，,。]\s*)(?:(?:把|将)\s*)?(?:起点|出发地|终点|目的地)\s*(?:改|换|是|在|为|设|[：:])/.test(text)) return "endpoint";
  if (/(?:刚才|前面|上一条|上一次|原来|同一个)(?:的)?(?:路线|起点|出发地|终点|目的地)|还是从那里出发/.test(text)) return "previous";
  if (/^\s*(?:就在|是在|在)\s*[\p{Script=Han}]{2,15}(?:市|区|县|省)[。！!？?]?\s*$/u.test(text)) return "area";
  return null;
}

export function mapIntentFromClassification(intent: MapIntent | null, text: string, hasRouteContext: boolean): MapIntent | null {
  if (!intent?.origin) return intent;
  const followUp = mapFollowUp(text);
  const namedOrigin = /(?:从|由)\s*[^，,。！？?!]{1,120}(?:到|去|前往|出发|开往|开车|驾车|往)|(?:起点|出发地|我现在在|我在)[是为在：:\s]*[\p{Script=Han}\d]/u.test(text);
  return namedOrigin || (hasRouteContext && followUp)
    ? intent : { destination: intent.destination };
}

const coordinate = /^-?\d+(?:\.\d+)?\s*[,，]\s*-?\d+(?:\.\d+)?$/;
const address = /^(?:[\p{Script=Han}\dA-Za-z·\- ]{2,60})(?:市|区|县|镇|村|街道|大街|大道|路|街|巷|弄|号(?:楼|院)?|栋|楼|交叉口|路口|小区|公寓|大厦|广场|中心|大学|学校|医院|车站|火车站|高铁站|地铁站|机场|酒店|公园|博物馆|美术馆|不夜城)(?:附近(?:一带)?|周边|一带|那一片|那边|那里|这边|左右)?$/u;
const commonPlace = /^(?:北京|上海|广州|深圳|西安|杭州|南京|成都|重庆|苏州|武汉|天津|大连|(?:上海)?(?:外滩|豫园|陆家嘴)|天安门|故宫|大雁塔|高新万达)$/;

function cleanPlace(text: string) {
  return text.trim().replace(/^[「『“"]|[」』”"]$/g, "").replace(/[，,、\s]+$/, "").trim();
}

export function mapIntent(text: string): MapIntent | null {
  const prompt = text.trim()
    .replace(/^(?:呃|嗯|啊|那个)[，,、\s]*/, "")
    .replace(/^(?:(?:嗨|嘿|hey)[，,、\s]*)?(?:jarvis|travis|贾维斯|喵维斯)[，,、\s：:]*/i, "")
    .replace(/[。！!？?，,\s]+$/, "");
  if (!prompt || /[\n；;]/.test(prompt)) return null;
  if (/^(?:请|麻烦)?\s*(?:帮我|给我)?\s*(?:打开|显示|展示)(?:一下)?\s*(?:文件|文件夹|网页|浏览器|应用|目录|项目)/.test(prompt)) return null;

  const route = prompt.match(/^(?:请|麻烦)?\s*(?:(?:帮我|给我)\s*)?(?:(?:规划|查|看看|导航|打开|显示|展示)(?:一下)?[，,、\s]*)?(?:(?:我想|我要)\s*)?(?:驾车|开车)?\s*从\s*(.+?)\s*(?:出发[，,、\s]*)?(?:到|去|前往)\s*(.+)$/);
  if (route) {
    const origin = cleanPlace(route[1]);
    const destination = cleanPlace(route[2].replace(/[的，,\s]*(?:(?:驾车)?路线|(?:全息|立体)?地图|怎么走|怎么开车|导航)(?:啊|呀|呢|吧)?$/, ""));
    const requestsRoute = /路线|怎么走|怎么开车|导航|地图/.test(prompt);
    const looksLikePlaces = address.test(origin) || address.test(destination) || commonPlace.test(origin) || commonPlace.test(destination);
    if (!/(?:步行|公交|骑行|坐飞机|坐火车|坐高铁|坐地铁|多长时间|多久|多远|多少钱)/.test(route[2]) &&
        origin && destination && origin.length <= 120 && destination.length <= 120 && (requestsRoute || looksLikePlaces)) {
      return { origin, destination };
    }
  }

  const placeMap = prompt.match(/^(?:请|麻烦)?\s*(?:帮我|给我)?\s*(?:(?:我想|我要)\s*)?(?:(?:打开|显示|展示|看看|查看|看|调出|查)(?:一下)?\s*)?([^，,：:]{2,120}?)(?:的)?(?:全息|立体)?地图(?:打开|展示|显示)?$/);
  if (placeMap && !/(?:怎么|为什么|什么|制作|开发|复刻|接入|浏览器|百度|高德|说说|介绍|讲讲)/.test(placeMap[1])) {
    return { destination: cleanPlace(placeMap[1]) };
  }
  const where = prompt.match(/^(.+?)(?:在(?:哪儿|哪里)|在哪)$/);
  if (where && (address.test(where[1]) || commonPlace.test(where[1]))) return { destination: cleanPlace(where[1]) };

  const namedMap = prompt.match(/^(?:请|麻烦)?\s*(?:帮我|给我)?\s*(?:打开|显示|展示|查看)(?:一下)?\s*(?:全息|立体)?地图[，,：:\s]+(.+)$/);
  if (namedMap && namedMap[1].length <= 120) return { destination: cleanPlace(namedMap[1]) };

  const command = prompt.match(/^(?:请|麻烦)?\s*(?:(?:帮我|给我)\s*)?(?:(?:在(?:全息)?地图上\s*)?(?:打开|显示|展示|标出|调出|定位(?:到)?|导航到|带我去)(?:一下)?\s*|(?:我想|我要)\s*(?:去|看)\s*)(.+?)(?:[的，,\s]*(?:全息|立体)?地图)?$/);
  if (command) {
    const destination = cleanPlace(command[1].replace(/^(?:地址|地点)[是为：:\s]+/, "").replace(/(?:[，,]\s*)?在哪里$/, ""));
    const mentionsMap = /地图|定位|标出|导航到|带我去|^(?:我想|我要)\s*去/.test(prompt);
    if (destination && destination.length <= 120 && (mentionsMap || address.test(destination) || coordinate.test(destination))) {
      return { destination };
    }
  }

  const destination = cleanPlace(prompt.replace(/^(?:地址|地点)(?:是|为|在|[：:])\s*/, ""));
  if (coordinate.test(destination)) return { destination };
  // A standalone address or recognizable place can open the map, but an
  // ordinary question or a request to write/read about one stays in chat.
  if (/(?:哪里|哪儿|是什么|介绍|说说|聊聊|写一|读一|总结|有几个|播报|翻译|工作目录|打开文件)/.test(destination)) return null;
  if (address.test(destination) || commonPlace.test(destination)) {
    return { destination };
  }
  return null;
}

export function readMapAction(text: string): MapIntent | null {
  const line = text.trim();
  const prefix = "JARVIS_MAP ";
  if (!line.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { origin, destination } = value as Record<string, unknown>;
    if (typeof destination !== "string" || !destination.trim() || destination.length > 120) return null;
    if (origin !== undefined && (typeof origin !== "string" || !origin.trim() || origin.length > 120)) return null;
    return origin ? { destination: destination.trim(), origin: origin.trim() } : { destination: destination.trim() };
  } catch {
    return null;
  }
}
