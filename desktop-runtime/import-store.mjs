import {validateWiki} from './wiki-validation.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const TOPICS=['家庭日常','物品与设备','健康','工作','学习','管家记忆'];
const META='记忆/记忆系统/metadata/入库';
const date=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const fail=message=>{throw Error(message);};
export async function safe(root,relative,create=false) {
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f]/.test(p))) fail('无效的工作区相对路径');
 let current=await fs.realpath(root);
 const parts=relative.split('/');
 for(let i=0;i<parts.length;i++) {
  current=path.join(current,parts[i]);
  let stat;try{stat=await fs.lstat(current);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(stat?.isSymbolicLink())fail('路径包含符号链接，已拒绝');
  if(i<parts.length-1){if(!stat&&create)await fs.mkdir(current,{mode:0o700,recursive:true});else if(stat&&!stat.isDirectory())fail('父路径不是目录');}
  else if(stat&&!stat.isFile())fail('目标不是普通文件');
 }
 return current;
}
export async function read(root,relative) {
 const file=await safe(root,relative);
 try {const st=await fs.stat(file);if(st.size>2*1024*1024)fail('文件过大，请分批处理');return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function atomic(root,relative,content) {
 const file=await safe(root,relative,true),tmp=file+'.'+randomUUID()+'.tmp';
 const fd=await fs.open(tmp,'wx',0o600);
 try{await fd.writeFile(content);await fd.sync();}finally{await fd.close();}
 await fs.rename(tmp,file);const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
const json=async(root,file,fallback)=>{const text=await read(root,file);return text===null?fallback:JSON.parse(text);};
const batchFile=id=>`${META}/batches/${/^[a-f0-9]{64}$/.test(id)?id:fail('批次标识无效')}.json`;
async function lock(root,fn) {
 const marker=await safe(root,`${META}/lock/owner.json`,true),dir=path.dirname(marker);
 // safe() creates ancestors; lock ownership itself uses an exclusive file.
 let fd;
 try{fd=await fs.open(marker,'wx',0o600);}catch(e){
  if(e.code!=='EEXIST')throw e;
  const owner=JSON.parse(await fs.readFile(marker,'utf8'));
  try{process.kill(owner.pid,0);fail('当前工作区已有入库操作，请稍后重试');}catch(error){if(error.code!=='ESRCH')throw error;}
  await fs.unlink(marker);fd=await fs.open(marker,'wx',0o600);
 }
 await fd.writeFile(JSON.stringify({pid:process.pid}));await fd.close();
 try{return await fn();}finally{await fs.unlink(marker).catch(()=>{});void dir;}
}
export function parseChat(file,buffer) {
 const rows=[];let cursor=0;
 while(true){
  const begin=buffer.indexOf('<!-- raw-chat ',cursor);if(begin<0)break;
  const end=buffer.indexOf(' -->\n\n',begin);if(end<0)fail('Raw 消息头不完整');
  const header=buffer.subarray(begin,end).toString();
  const size=Number(header.match(/\bbytes=(\d+)$/)?.[1]);
  const role=header.match(/\brole=(user|assistant)\b/)?.[1];
  const captured=Number(header.match(/captured_at_ms=(\d+)/)?.[1]);
  if(!Number.isSafeInteger(size)||size<0||!role||!Number.isFinite(captured))fail('Raw 消息元数据无效');
  const start=end+6,finish=start+size;if(finish>buffer.length)fail('Raw 消息正文不完整');
  const text=buffer.subarray(start,finish).toString('utf8');
  const messageId=header.match(/\bid="([a-zA-Z0-9-]+)"/)?.[1]||hash(`${file}:${begin}:${captured}`);
  rows.push({id:hash(`${file}:${messageId}`),messageId,file,begin,boundaryHash:hash(buffer.subarray(begin,finish)),start,end:finish,hash:hash(buffer.subarray(start,finish)),role,captured,text});
  cursor=finish+1;
 }
 return rows;
}
export async function sources(root,{from,to}={}) {
 const rows=[];
 for(const dir of ['聊天记录','记忆条目']) {
  const relative=`记忆/raw/${dir}`;
  await safe(root,`${relative}/.probe`);
  let names;try{names=await fs.readdir(path.join(root,relative));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(names.length>2000)fail('Raw 文件过多，请先缩小目录范围');
  for(const name of names.filter(n=>n.endsWith('.md')).sort()) {
   const file=`${relative}/${name}`,text=await read(root,file);if(text===null)continue;
   const buffer=Buffer.from(text);
   if(dir==='聊天记录')rows.push(...parseChat(file,buffer));
   else {const captured=Number(text.match(/^captured_at_ms: (\d+)/m)?.[1]);if(!captured)continue;rows.push({id:hash(file),messageId:hash(file),file,start:0,end:buffer.length,hash:hash(buffer),role:'user',captured,text});}
  }
 }
 const min=from?Date.parse(from):0,max=to?Date.parse(to):Infinity;
 if(!Number.isFinite(min)||Number.isNaN(max))fail('时间范围无效');
 return rows.filter(r=>r.captured>=min&&r.captured<=max).sort((a,b)=>a.captured-b.captured||a.file.localeCompare(b.file)||a.start-b.start);
}
export async function verifySources(root,items) {
 for(const source of items){const text=await read(root,source.file);if(text===null||hash(Buffer.from(text).subarray(source.start,source.end))!==source.hash||(source.boundaryHash&&hash(Buffer.from(text??'').subarray(source.begin,source.end))!==source.boundaryHash))fail('来源已修改或删除，请重新选择范围并生成提案');}
}
export async function loadBatch(root,id){const batch=await json(root,batchFile(id),null);if(!batch)fail('找不到入库批次');return batch;}
export async function batches(root) {
 const dir=path.join(root,META,'batches');await safe(root,`${META}/batches/.probe`);
 let names;try{names=await fs.readdir(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}
 const result=[];for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const b=await loadBatch(root,name.slice(0,-5));result.push({id:b.id,created:b.created,revision:b.revision,counts:counts(b),scope:b.scope});}
 return result.sort((a,b)=>b.created-a.created);
}
export function counts(batch){const result={pending:0,success:0,duplicate:0,skipped:0,revoked:0};for(const c of batch.candidates||[])result[c.status==='success'&&c.action==='duplicate'?'duplicate':c.status]++;return result;}
export async function snapshot(root,selection,scope='') {
 if(!Array.isArray(selection)||!selection.length||selection.length>200)fail('请选中 1 到 200 条消息');
 const all=await sources(root),chosen=selection.map(ref=>all.find(row=>row.id===ref.id&&row.hash===ref.hash)||fail('选中消息已变化，请刷新列表'));
 if(new Set(chosen.map(s=>s.id)).size!==chosen.length)fail('来源重复选择');
 if(chosen.reduce((n,s)=>n+Buffer.byteLength(s.text),0)>128*1024)fail('本批来源过多，请缩小范围');
 const id=hash(JSON.stringify(chosen.map(s=>[s.id,s.hash]).sort()));
 return lock(root,async()=>{
  const old=await json(root,batchFile(id),null);if(old)return old;
  const batch={id,workspace:await fs.realpath(root),created:Date.now(),scope,revision:1,sources:chosen,candidates:[],versions:{},proposalReady:false};
  await atomic(root,batchFile(id),JSON.stringify(batch));return batch;
 });
}
function pageName(page) {
 if(typeof page!=='string'||!TOPICS.includes(page.split('/')[0])||page.split('/').length!==2||!/^[\p{L}\p{N} _.-]+\.md$/u.test(page.split('/')[1])||page.split('/')[1].startsWith('.'))fail('目标页面必须位于已定义的主题目录');
 return `记忆/wiki/${page}`;
}
function candidate(batch,value,index) {
 const statement=String(value.statement||'').trim();if(!statement||statement.length>3000||/<!--|<script/i.test(statement))fail('候选正文无效');
 if(value.sensitivity==='secret'||/sk-[a-zA-Z0-9]{16,}|(?:密码|验证码|私钥)\s*[：:]/.test(statement))fail('秘密信息不能入库');
 const refs=value.sources;if(!Array.isArray(refs)||!refs.length||refs.some(id=>!batch.sources.some(s=>s.id===id)))fail('候选缺少选中范围内的来源');
 pageName(value.page);
 if(value.replaceText && (/<!--|^---/m.test(value.replaceText)))fail('更新依据不能包含元数据或托管记录边界，请只定位具体正文');
 if(!['add','update','duplicate','review'].includes(value.action))fail('候选动作无效');
 if(!['ordinary','sensitive','impression'].includes(value.sensitivity))fail('必须明确候选敏感性');
 const userEvidence=batch.sources.some(s=>refs.includes(s.id)&&s.role==='user');
 return {id:hash(`${batch.id}:${index}:${statement}:${value.page}`),statement,page:value.page,summary:String(value.summary||statement).slice(0,120),action:value.action,sensitivity:userEvidence?value.sensitivity:'impression',sources:refs,time:String(value.time||'未确定').replace(/[\r\n]/g,' ').slice(0,300),notes:String(value.notes||''),replaceText:String(value.replaceText||''),todo:value.todo===true,status:'pending'};
}
export async function saveProposal(root,id,revision,values,versions) {
 return lock(root,async()=>{
  if(await read(root,`${META}/journal.json`)!==null)fail('请先恢复未完成的提交');
  const batch=await loadBatch(root,id);if(batch.revision!==revision)fail('提案版本已变化，请重新打开');
  if(batch.candidates.some(c=>['success','revoked'].includes(c.status)))fail('已有已处理候选，不能重新生成覆盖；请编辑尚未确认条目');
  await verifySources(root,batch.sources);
  if(!Array.isArray(values)||values.length>50)fail('候选数量无效');
  const candidates=values.map((v,i)=>candidate(batch,v,i));
  for(const c of candidates){const file=pageName(c.page),old=await read(root,file);if(old!==null&&!Object.hasOwn(versions,file))fail('模型尚未读取目标页面，请重新核对');if(Object.hasOwn(versions,file)&&versions[file]!==hash(old??''))fail('目标页面已变化，请重新生成提案');if(old===null)versions[file]=hash('');if(['update','duplicate'].includes(c.action)&&(!c.replaceText||!old?.includes(c.replaceText)))fail('更新或重复项缺少可定位的已有正文');}
  for(const [file,version] of Object.entries(versions))if(hash((await read(root,file))??'')!==version)fail('核对过的 Wiki 已变化，请重新生成提案');
  batch.candidates=candidates;batch.versions=versions;batch.proposalReady=true;batch.revision++;
  await atomic(root,batchFile(id),JSON.stringify(batch));return batch;
 });
}
export async function editCandidate(root,id,revision,candidateId,patch) {
 return lock(root,async()=>{
  if(await read(root,`${META}/journal.json`)!==null)fail('请先恢复未完成的提交');
  const b=await loadBatch(root,id);if(b.revision!==revision)fail('提案版本已变化');
  const old=b.candidates.find(c=>c.id===candidateId);if(!old||!['pending','skipped'].includes(old.status))fail('只能编辑尚未写入的候选');
  const updated=candidate(b,{...old,...patch},b.candidates.indexOf(old));updated.id=old.id;
  const file=pageName(updated.page);const text=await read(root,file);
  if(updated.page!==old.page&&text!==null)fail('更改到已有页面需要重新生成提案核对正文；可选择新的主题页面');
  if(updated.page===old.page && b.versions[file]!==hash(text??''))fail('目标页面已变化，请重新生成提案');
  b.versions[file]=hash(text??'');Object.assign(old,updated);b.revision++;
  await atomic(root,batchFile(id),JSON.stringify(b));return b;
 });
}
const marker=id=>`<!-- meowvis-import:${id} -->`;
const endMarker=id=>`<!-- /meowvis-import:${id} -->`;
function block(c,b) {
 const references=c.sources.map(id=>b.sources.find(s=>s.id===id)).map(s=>{
  const from=path.posix.dirname(pageName(c.page));const relative=path.posix.relative(from,s.file).split('/').map(encodeURIComponent).join('/');
  return `- [Raw 来源](${relative}) · 消息 ${s.messageId} · 字节 ${s.start}–${s.end} · ${new Date(s.captured).toISOString()}`;
 }).join('\n');
 return `${marker(c.id)}\n${c.statement}\n\n时间或有效范围：${c.time}\n${c.action==='update'?`\n变更前记录：${c.replaceText}\n`:''}\n${references}\n${endMarker(c.id)}`;
}
function indexEntry(index,c){const link=c.page.split('/').map(encodeURIComponent).join('/');const line=`- [${c.page.split('/')[1].slice(0,-3)}](${link})：${c.summary.replace(/\n/g,' ')}`;const lines=index.split('\n');const found=lines.findIndex(l=>l.includes(`](${link})`)||l.includes(`](${c.page})`));if(found>=0){lines[found]=line;return lines.join('\n');}const heading=`## ${c.page.split('/')[0]}`;const at=lines.findIndex(l=>l.trim()===heading);if(at<0)return index+`\n${heading}\n\n${line}\n`;lines.splice(at+1,0,'',line);return lines.join('\n');}
async function validateDocuments(root,changes) {
 for(const [file,text] of Object.entries(changes)){
  if(!file.startsWith('记忆/wiki/'))continue;
  if(!/^---\n[\s\S]*?\btype:\s*\S+[\s\S]*?\n---/m.test(text)||!/^date: \d{4}-\d{2}-\d{2}$/m.test(text))fail(`页面元数据无效：${file}`);
  for(const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)){
   const link=decodeURIComponent(match[1].replace(/^<|>$/g,''));if(/^[a-z]+:/i.test(link)||link.startsWith('#'))continue;
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),link.split('#')[0]));
   if(!target.startsWith('记忆/'))fail(`页面链接越界：${file}`);
   if(!Object.hasOwn(changes,target)&&await read(root,target)===null)fail(`页面链接缺失：${target}`);
  }
 }
}
async function applyJournal(root,journal,inject) {
 await verifySources(root,journal.sources);
 // Check all versions before the first mutation, including a resumed transaction.
 for(const edit of journal.edits){const current=await read(root,edit.file);if(hash(current??'')!==edit.beforeHash&&hash(current??'')!==hash(edit.after))fail(`提交期间页面被修改，停止恢复：${edit.file}`);}
 let n=0;
 for(const edit of journal.edits){const currentHash=hash((await read(root,edit.file))??'');if(currentHash!==edit.beforeHash&&currentHash!==hash(edit.after))fail('写入时检测到并发修改，已停止');if(currentHash!==hash(edit.after))await atomic(root,edit.file,edit.after);if(inject)await inject(++n);}
 const changes=Object.fromEntries(journal.edits.map(e=>[e.file,e.after]));await validateDocuments(root,changes);
 for(const e of journal.edits)if(hash((await read(root,e.file))??'')!==hash(e.after))fail('写入后核对不一致');
 if(await read(root,'记忆/scripts/lint.py')!==null){
  await validateWiki(await safe(root,'记忆/scripts/lint.py'),path.join(root,'记忆'));
 }
 await atomic(root,batchFile(journal.batch.id),JSON.stringify(journal.batch));
 await fs.unlink(await safe(root,`${META}/journal.json`));return journal.batch;
}
export async function commit(root,id,revision,selected,risks=[],inject) {
 return lock(root,async()=>{
  const pending=await json(root,`${META}/journal.json`,null);
  if(pending){if(pending.batch.id!==id)fail('另一个批次需要先恢复');return applyJournal(root,pending,inject);}
  if(await read(root,`${META}/journal.json`)!==null)fail('请先恢复未完成的提交');
  const b=await loadBatch(root,id);if(b.revision!==revision)fail('提案版本已变化，原确认无效');
  await verifySources(root,b.sources);
  for(const [file,version]of Object.entries(b.versions))if(!['记忆/wiki/index.md','记忆/wiki/维护/log.md','记忆/wiki/待办与维护.md'].includes(file)&&hash((await read(root,file))??'')!==version)fail('相关 Wiki 已变化，请重新核对提案');
  if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length)fail('请逐条选择要确认的候选');
  const approved=selected.map(id=>b.candidates.find(c=>c.id===id)||fail('候选不存在'));
  if(approved.some(c=>c.status==='revoked'))fail('已撤回条目不能通过旧批次重新写回');
  for(const c of approved)if(c.status==='success'){
   const text=await read(root,pageName(c.page));if(!text||(c.action==='duplicate'?!text.includes(c.replaceText):!text.includes(c.receipt.block)))fail('已收录内容被修改或删除，不能自动恢复');
  }
  const todo=approved.filter(c=>c.status!=='success');if(!todo.length)return b;
  for(const c of todo)if((c.sensitivity!=='ordinary'||c.notes||c.action==='review')&&!risks.includes(c.id))fail('敏感、歧义或冲突项需要单独确认');
  const changes={},before={};
  const get=async file=>{if(Object.hasOwn(changes,file))return changes[file];const value=await read(root,file);before[file]=hash(value??'');changes[file]=value??'';return changes[file];};
  let index=await get('记忆/wiki/index.md');if(!index)fail('请先建立 Wiki 总索引');
  for(const c of todo){
   const file=pageName(c.page);let text=await get(file);
   if(before[file]!==b.versions[file])fail(`页面已被其他操作修改，请重新核对提案：${c.page}`);
   if(c.action==='duplicate'){if(!text.includes(c.replaceText))fail('重复项依据已变化');c.receipt={page:file,block:c.replaceText};}
   else{
    const addition=block(c,b);if(!text)text=`---\ntype: record\ndate: ${date()}\n---\n\n# ${c.page.split('/')[1].slice(0,-3)}\n`;
    if(c.action==='update'){if(!c.replaceText||text.split(c.replaceText).length!==2)fail('更新依据不唯一或已变化');text=text.replace(c.replaceText,addition);}else text+=`\n\n${addition}\n`;
    changes[file]=text;c.receipt={page:file,block:addition,restore:c.action==='update'?c.replaceText:''};
    index=indexEntry(index,c);
    if(c.todo){const file='记忆/wiki/待办与维护.md';let text=await get(file);if(!text)text=`---\ntype: tasks\ndate: ${date()}\n---\n\n# 待办与维护\n`;const link=c.page.split('/').map(encodeURIComponent).join('/');text+=`\n${marker(c.id)}\n- [ ] [${c.statement.replace(/\n/g,' ')}](${link}) · ${c.time}\n${endMarker(c.id)}\n`;changes[file]=text;if(!index.includes('待办与维护.md'))index+='\n- [待办与维护](待办与维护.md)\n';}
   }
   c.status='success';c.confirmation={revision,at:Date.now()};
  }
  changes['记忆/wiki/index.md']=index;
  const logFile='记忆/wiki/维护/log.md';let log=await get(logFile);if(!log)log=`---\ntype: maintenance-log\ndate: ${date()}\ngraph-excluded: true\n---\n\n# 维护日志\n`;changes[logFile]=log+`\n- ${date()} | import | 批次 ${id.slice(0,12)} 提交 ${todo.length} 条确认项。\n`;
  await validateDocuments(root,changes);
  for(const [file,text]of Object.entries(changes))b.versions[file]=hash(text);
  b.revision++;b.lastReceipt={at:Date.now(),selected:todo.map(c=>c.id),counts:counts(b),pages:[...new Set(todo.map(c=>c.page))],search:'pending'};
  const journal={sources:b.sources,batch:b,edits:Object.entries(changes).map(([file,after])=>({file,after,beforeHash:before[file]}))};
  await atomic(root,`${META}/journal.json`,JSON.stringify(journal));
  return applyJournal(root,journal,inject);
 });
}
export async function skip(root,id,revision,ids) {
 return lock(root,async()=>{if(await read(root,`${META}/journal.json`)!==null)fail('请先恢复未完成的提交');const b=await loadBatch(root,id);if(b.revision!==revision)fail('提案版本已变化');for(const id of ids){const c=b.candidates.find(c=>c.id===id);if(!c||!['pending','skipped'].includes(c.status))fail('不能跳过已处理条目');c.status='skipped';}b.revision++;await atomic(root,batchFile(id),JSON.stringify(b));return b;});
}
export async function revoke(root,id,revision,candidateId) {
 return lock(root,async()=>{
  if(await read(root,`${META}/journal.json`)!==null)fail('请先恢复未完成的提交');
  if(await read(root,`${META}/journal.json`)!==null)fail('请先恢复未完成的提交');
  const b=await loadBatch(root,id);if(b.revision!==revision)fail('提案版本已变化');const c=b.candidates.find(c=>c.id===candidateId);if(!c||c.status!=='success')fail('只能撤回本工具成功写入的候选');
  const edits=[];
  if(c.action!=='duplicate'){
   const current=await read(root,c.receipt.page);if(!current?.includes(c.receipt.block))fail('正文已被修改，请人工核对撤回范围');
   edits.push({file:c.receipt.page,beforeHash:hash(current),after:current.replace(c.receipt.block,c.receipt.restore||'')});
   const file='记忆/wiki/待办与维护.md',tasks=await read(root,file);
   if(tasks?.includes(marker(c.id))){const a=tasks.indexOf(marker(c.id)),z=tasks.indexOf(endMarker(c.id),a)+endMarker(c.id).length;edits.push({file,beforeHash:hash(tasks),after:tasks.slice(0,a)+tasks.slice(z)});}
  }
  const logFile='记忆/wiki/维护/log.md', log=await read(root,logFile);
  if(log!==null)edits.push({file:logFile,beforeHash:hash(log),after:log+`\n- ${date()} | revoke | 批次 ${id.slice(0,12)} 撤回条目 ${c.id.slice(0,12)}。\n`});
  const indexFile='记忆/wiki/index.md',index=await read(root,indexFile);
  if(index!==null)edits.push({file:indexFile,beforeHash:hash(index),after:indexEntry(index,{...c,summary:'记录已撤回，历史内容以正文为准'})});
  if(b.lastReceipt)b.lastReceipt.search='pending';
  c.status='revoked';c.revokedAt=Date.now();b.revision++;
  for(const e of edits)b.versions[e.file]=hash(e.after);
  const journal={sources:[],batch:b,edits};await atomic(root,`${META}/journal.json`,JSON.stringify(journal));return applyJournal(root,journal);
 });
}
export async function refresh(root,id) {
 return lock(root,async()=>{
  const b=await loadBatch(root,id);if(!b.lastReceipt)fail('该批次尚未成功入库');
  try{await execute(await safe(root,'记忆/scripts/qmd'),['update'],{cwd:root,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH||'')},timeout:60000,maxBuffer:1024*1024});b.lastReceipt.search='updated';}
  catch{b.lastReceipt.search='failed';}
  await atomic(root,batchFile(id),JSON.stringify(b));return b;
 });
}
