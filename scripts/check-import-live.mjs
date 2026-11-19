// Synthetic-only evaluation. Credentials enter through stdin and are never printed.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sources,snapshot,commit,read} from '../desktop-runtime/import-store.mjs';
import {generate} from '../desktop-runtime/import-model.mjs';
let secret='';for await(const chunk of process.stdin)secret+=chunk;
const key=JSON.parse(secret).deepseek;secret='';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'meowvis-live-import-'));
try{
 const meta='---\ntype: record\ndate: 2026-11-19\n---\n';
 await fs.mkdir(path.join(root,'记忆/raw/聊天记录'),{recursive:true});
 await fs.mkdir(path.join(root,'记忆/wiki/物品与设备'),{recursive:true});
 await fs.writeFile(path.join(root,'记忆/wiki/index.md'),meta+'# 索引\n## 物品与设备\n- [测试设备](物品与设备/测试设备.md)：设备清洁计划\n');
 await fs.writeFile(path.join(root,'记忆/wiki/物品与设备/测试设备.md'),meta+'# 测试设备\n\n合成测试用户计划每月清洁测试键盘一次。\n');
 const text='这是合成验收资料。我的学习安排暂定为每周读两章天文学教材。另外，我计划每月清洁测试键盘一次。';
 await fs.writeFile(path.join(root,'记忆/raw/聊天记录/2026-11-19.md'),`<!-- raw-chat role=user channel="text" thread=null captured_at_ms=1795017600000 id="synthetic-1" bytes=${Buffer.byteLength(text)} -->\n\n${text}\n`);
 let b=await snapshot(root,await sources(root),'合成学习与设备资料');
 b=await generate(root,b,key);
 console.log(JSON.stringify({candidates:b.candidates.map(c=>({action:c.action,page:c.page,statement:c.statement})),wikiUnchanged:(await read(root,'记忆/wiki/物品与设备/测试设备.md')).includes('合成测试用户计划')}));
 if(!b.candidates.some(c=>c.page.startsWith('学习/'))||!b.candidates.some(c=>c.action==='duplicate'))throw Error('真实模型未识别跨主题或已有事实');
 const selected=b.candidates.filter(c=>c.page.startsWith('学习/'));b=await commit(root,b.id,b.revision,selected.map(c=>c.id),selected.map(c=>c.id));
 console.log(JSON.stringify({success:b.candidates.filter(c=>c.status==='success').length,pending:b.candidates.filter(c=>c.status==='pending').length,syntheticOnly:true}));
}finally{await fs.rm(root,{recursive:true,force:true});}
