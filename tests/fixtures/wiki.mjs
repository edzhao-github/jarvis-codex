import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
export async function wikiFixture() {
 const root=await mkdtemp(path.join(tmpdir(),'meowvis-wiki-fixture-'));
 const page=async(relative,type,body)=>{const file=path.join(root,'记忆/wiki',relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,`---\ntype: ${type}\n---\n\n${body}\n`);};
 await page('index.md','wiki-index','# Wiki\n\n## 设定与档案\n\n- [设定](喵维斯设定.md)\n- [档案](用户档案索引.md)\n\n## 物品与设备\n- [咖啡机维护](物品与设备/咖啡机维护.md)：清洁周期。\n- [耗材位置](物品与设备/耗材位置.md)：耗材收纳。\n- [学习计划](学习/课程安排.md)：已登记的学习计划。');
 await page('用户档案索引.md','profile-index','# 档案索引\n\n## Wiki 查阅入口\n\n- [家庭](家庭日常/个人与家庭档案.md)\n- [偏好](管家记忆/已确认偏好.md)\n- [工作](工作/工作档案.md)\n\n## 记录规则\n仅确认后入库。');
 await page('喵维斯设定.md','assistant-settings','# 合成角色\n简短回答。');
 await page('家庭日常/个人与家庭档案.md','user-profile','# 家庭\n\n## 关于我\n合成资料。\n\n## 我的宠物\n猫云朵（母猫）、猫山竹（公猫）。\n\n## 生活\n合成私人字段，不应随宠物查询输出。');
 await page('管家记忆/已确认偏好.md','user-profile','# 偏好\n\n## 我的偏好\n喜欢喝合成茶。');
 await page('工作/工作档案.md','user-profile','# 工作\n\n## 工作\n公司名称：合成工作室。');
 await page('物品与设备/咖啡机维护.md','record','# 咖啡机维护\n每隔六周清洁一次滤网。清洁片的位置见 [耗材位置](耗材位置.md)。');
 await page('物品与设备/耗材位置.md','record','# 耗材位置\n咖啡机清洁片放在蓝色柜子第二层。');
 await writeFile(path.join(root,'记忆/.wiki-read-mode'),'wiki');
 return {root,cleanup:()=>rm(root,{recursive:true,force:true})};
}
