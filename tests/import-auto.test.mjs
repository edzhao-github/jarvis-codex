import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {automaticImport,rangeFor} from '../desktop-runtime/import-auto.mjs';
import {saveProposal,read,commit} from '../desktop-runtime/import-store.mjs';
const meta='---\ntype: record\ndate: 2026-11-19\n---\n';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'meowvis-auto-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'记忆/raw/聊天记录'),{recursive:true});await fs.mkdir(path.join(root,'记忆/wiki'),{recursive:true});await fs.writeFile(path.join(root,'记忆/wiki/index.md'),meta+'# 索引\n');return root;}
async function append(root,text,id,captured){await fs.appendFile(path.join(root,'记忆/raw/聊天记录/2026-11-19.md'),`<!-- raw-chat role=user channel="text" thread=null captured_at_ms=${captured} id="${id}" bytes=${Buffer.byteLength(text)} -->\n\n${text}\n`);}
const request={consent:true,period:'range',from:'2026-11-19T00:00:00+08:00',to:'2026-11-19T12:00:00+08:00',cutoff:'2026-11-19T12:00:00+08:00'};
test('today uses local midnight and frozen cutoff; malformed ranges rejected',()=>{const now=new Date(2026,10,19,12,30);const range=rangeFor({period:'today'},now);assert.equal(new Date(range.from).getHours(),0);assert.equal(range.to,now.toISOString());assert.throws(()=>rangeFor({period:'range',from:'bad',to:'bad'},now));});
test('one request saves ordinary topics, leaves only risky questions, and repeated day adds new sources only',async t=>{
 const root=await fixture(t),time=Date.parse('2026-11-19T09:00:00+08:00');await append(root,'学习安排','one',time);await append(root,'设备状态','two',time+1);let calls=0;
 const model=async(root,b)=>{calls++;return saveProposal(root,b.id,b.revision,b.sources.map((s,i)=>({statement:s.text,page:s.messageId==='three'?'工作/安排.md':i===0?'学习/安排.md':'物品与设备/状态.md',action:i===1?'review':'add',sensitivity:'ordinary',notes:i===1?'设备型号转写不确定':'',sources:[s.id]})),{});};
 let r=await automaticImport(root,request,'synthetic-key',model);assert.equal(r.saved,1);assert.equal(r.pending.length,1);assert.equal(await read(root,'记忆/wiki/物品与设备/状态.md'),null);
 r=await automaticImport(root,request,'synthetic-key',model);assert.equal(r.saved,0);assert.equal(calls,1);assert.equal(r.pending.length,1);
 await append(root,'新工作事项','three',time+2);r=await automaticImport(root,request,'synthetic-key',model);assert.equal(r.saved,1);assert.equal(calls,2);assert.ok(await read(root,'记忆/wiki/工作/安排.md'));
 const pending=r.pending[0];const confirmed=await commit(root,pending.batchId,pending.revision,[pending.id],[pending.id]);assert.equal(confirmed.candidates.find(c=>c.id===pending.id).status,'success');
});
test('request cutoff excludes later conversation and no-data does not invoke model',async t=>{const root=await fixture(t);await append(root,'下午的新消息','late',Date.parse('2026-11-19T13:00:00+08:00'));const r=await automaticImport(root,request,'fake',()=>{throw Error('must not run');});assert.equal(r.messages,0);await assert.rejects(automaticImport(root,{...request,consent:false},'fake'),/明确/);});
