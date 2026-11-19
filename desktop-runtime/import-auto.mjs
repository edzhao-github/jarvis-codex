import * as store from './import-store.mjs';
import {generate} from './import-model.mjs';

export function rangeFor(request,now=new Date()) {
 const cutoff=new Date(request.cutoff??now);
 if(!Number.isFinite(cutoff.getTime())||cutoff>now)throw Error('整理截止时间无效');
 let from,to=cutoff;
 if(request.period==='today'||request.period===undefined){from=new Date(cutoff);from.setHours(0,0,0,0);}
 else if(request.period==='range') {from=new Date(request.from);to=new Date(Math.min(new Date(request.to).getTime(),cutoff.getTime()));}
 else throw Error('请说明需要整理的日期或时间范围');
 if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>to)throw Error('整理时间范围无效');
 return {from:from.toISOString(),to:to.toISOString()};
}
export async function automaticImport(root,request,key,model=generate) {
 if(request.consent!==true)throw Error('需要用户明确提出整理入库');
 const range=rangeFor(request),rows=await store.sources(root,range);
 const result={range,messages:rows.length,saved:0,duplicate:0,alreadyProcessed:0,pending:[],pages:[],search:'unchanged'};
 if(!rows.length)return result;
 // Reuse the exact recorded source boundary; never infer that a whole day is processed.
 const previous=await store.batches(root),seen=new Set();
 for(const entry of previous){const b=await store.loadBatch(root,entry.id);
  if(b.sources.every(s=>rows.some(r=>r.id===s.id&&r.hash===s.hash))&&b.proposalReady){
   // Pending ordinary items from an earlier interrupted run can be finished under
   // this new explicit request; previously skipped and revoked items stay untouched.
   await store.verifySources(root,b.sources);
   await finish(b);for(const s of b.sources)seen.add(s.id+':'+s.hash);
  }
 }
 let chunk=[],bytes=0;
 for(const row of rows.filter(r=>!seen.has(r.id+':'+r.hash))){
  const size=Buffer.byteLength(row.text);if(size>120*1024)throw Error('单条消息过长，无法自动整理');
  if(chunk.length&&(chunk.length>=120||bytes+size>120*1024)){await processChunk(chunk);chunk=[];bytes=0;}
  chunk.push(row);bytes+=size;
 }
 if(chunk.length)await processChunk(chunk);
 result.pages=[...new Set(result.pages)];return result;
 async function processChunk(selected){
  let b=await store.snapshot(root,selected,request.scope||`${range.from} 至 ${range.to}`);
  if(!b.proposalReady)b=await model(root,b,key);
  await finish(b);
 }
 async function finish(b){
  const pending=b.candidates.filter(c=>c.status==='pending');
  const ordinary=pending.filter(c=>c.sensitivity==='ordinary'&&!c.notes&&['add','update','duplicate'].includes(c.action));
  const handled=b.candidates.filter(c=>['success','revoked','skipped'].includes(c.status));
  result.alreadyProcessed+=handled.length;
  if(ordinary.length){
   b=await store.commit(root,b.id,b.revision,ordinary.map(c=>c.id));
   result.saved+=ordinary.filter(c=>c.action!=='duplicate').length;result.duplicate+=ordinary.filter(c=>c.action==='duplicate').length;
   result.pages.push(...ordinary.map(c=>c.page));
   try{b=await store.refresh(root,b.id);if(result.search!=='failed')result.search=b.lastReceipt.search;}catch{result.search='failed';}
  }
  for(const c of b.candidates.filter(c=>c.status==='pending'))result.pending.push({batchId:b.id,revision:b.revision,id:c.id,statement:c.statement,page:c.page,reason:c.notes||c.sensitivity});
 }
}

export function confirmationReceipt(b){
 return {counts:store.counts(b),pages:b.lastReceipt?.pages||[],search:b.lastReceipt?.search,pending:b.candidates.filter(c=>c.status==='pending').map(c=>({batchId:b.id,revision:b.revision,id:c.id,statement:c.statement,page:c.page,reason:c.notes||c.sensitivity}))};
}
