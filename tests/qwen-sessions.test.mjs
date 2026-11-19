import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ConversationSessions} from '../experiments/qwen-voice/sessions.mjs';
import {HarnessRunner} from '../experiments/qwen-voice/harness.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'meowvis-sessions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'work'));return {home:path.join(root,'home'),workspace:path.join(root,'work')};}
test('reopen restores recent conversation, explicit new keeps old history, workspaces isolated',async t=>{
 const config=await fixture(t),first=await new ConversationSessions(config).open(),id=first.data.id;
 await Promise.all([first.append('user','先讨论设备维护','u1'),first.append('assistant','再核对学习安排','a1')]);
 await first.append('user','重复事件忽略','u1');
 const restored=await new ConversationSessions(config).open();assert.equal(restored.data.id,id);assert.equal(restored.data.turns.length,2);assert.match(restored.context(),/设备维护/);
 await restored.create();assert.notEqual(restored.data.id,id);assert.equal(restored.context(),'');assert.equal((await restored.list()).length,2);
 await restored.select(id);assert.match(restored.context(),/学习安排/);
 const other=path.join(config.workspace,'other');await fs.mkdir(other);const isolated=await new ConversationSessions({...config,workspace:other}).open();assert.notEqual(isolated.data.id,id);await assert.rejects(isolated.select(id),/不属于/);
});
test('context window is bounded, crashed task becomes interrupted and is not run',async t=>{
 const config=await fixture(t),store=await new ConversationSessions(config).open();
 for(let n=0;n<90;n++)await store.append('user','第'+n+'条 '+('x'.repeat(1000)),String(n));
 await store.task({state:'running',request:'合成未完成任务'});
 const restored=await new ConversationSessions(config).open();assert.equal(restored.data.task.state,'interrupted');assert.ok(restored.context().length<18000);assert.match(restored.context(),/不得自动重跑/);assert.ok(restored.data.turns.length<=80);
});
test('corrupted current pointer does not silently start a fresh conversation',async t=>{const config=await fixture(t),store=await new ConversationSessions(config).open();await fs.writeFile(path.join(store.dir,'current.json'),'broken');await assert.rejects(new ConversationSessions(config).open());});
test('Harness restores the persisted SDK identity only on a new explicit task',async t=>{
 const config=await fixture(t),store=await new ConversationSessions(config).open();let starts=0,resumes=0,runs=0;const id='session-'+'a'.repeat(32);
 class Harness {client={start(){},onRequest(){}};async start(){starts++;}session(){return {id,run:async()=>{runs++;return {finishReason:'completed',finalResponse:'synthetic done'};}};}async resumeSession(old){resumes++;assert.equal(old,id);return this.session();}async close(){}}
 const first=new HarnessRunner({...config,conversation:store,factory:Harness,key:'synthetic'});await first.run('创建合成清单');await first.close();assert.equal(store.data.harnessId,id);
 const second=new HarnessRunner({...config,conversation:await new ConversationSessions(config).open(),factory:Harness,key:'synthetic'});assert.equal(runs,1);await second.run('读取刚才的合成清单');assert.equal(resumes,1);assert.equal(starts,2);assert.equal(runs,2);await second.close();
});
test('missing Harness history does not fall back or execute a task',async t=>{
 const config=await fixture(t),store=await new ConversationSessions(config).open();await store.bindHarness('session-'+'b'.repeat(32));let runs=0;
 class Harness {client={start(){},onRequest(){}};async start(){}session(){runs++;throw Error('must not create');}async resumeSession(){throw Error('missing');}async close(){}}
 const runner=new HarnessRunner({...config,conversation:store,factory:Harness,key:'synthetic'});assert.match((await runner.run('继续')).error,/restoration failed/);assert.equal(runs,0);await runner.close();
});
