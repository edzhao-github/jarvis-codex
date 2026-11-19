import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../src/profile-map.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source);
const {resolveProfileMap} = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const profile = `# 测试档案\n- 公司名称：示例公司。（测试）\n- 公司地址：测试路185号。（测试）\n- 居住小区：测试小区。（测试）\n- 上班时间：09:00—18:00。\n- 喜欢：测试偏好。`;

test("explicit company and home aliases resolve from saved fields only", () => {
  assert.deepEqual(resolveProfileMap({origin:"公司", destination:"家"}, profile), {
    origin:"测试路185号 示例公司", destination:"测试小区"
  });
});
test("explicit endpoints win; schedules never imply live position", () => {
  const intent = {origin:"测试车站", destination:"测试公园", route:true};
  assert.deepEqual(resolveProfileMap(intent, profile), intent);
  assert.deepEqual(resolveProfileMap({destination:"测试公园"}, profile), {destination:"测试公园"});
});
test("missing fields are not invented and unrelated private data is not exposed", () => {
  const intent = {origin:"公司", destination:"家"};
  assert.deepEqual(resolveProfileMap(intent, null), intent);
  assert.deepEqual(resolveProfileMap(intent, "# 空白档案"), intent);
  assert.doesNotMatch(JSON.stringify(resolveProfileMap(intent, profile)), /测试偏好|上班时间/);
});
test("latest supplied profile replaces old address", () => {
  assert.equal(resolveProfileMap({destination:"公司"}, profile.replace("测试路185号", "新测试路2号")).destination,
    "新测试路2号 示例公司");
});

test("explicit default origin is resolved locally and absent defaults still ask for an origin", () => {
  const intent = {origin:"档案默认起点", destination:"测试公园"};
  assert.deepEqual(resolveProfileMap(intent, profile + "\n- 出行默认起点：以后规划路线时，默认从上述居住小区出发。"), {
    origin:"测试小区", destination:"测试公园", route:true,
  });
  assert.deepEqual(resolveProfileMap(intent, profile), {
    origin:undefined, destination:"测试公园", route:true,
  });
});
