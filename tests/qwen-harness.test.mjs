import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HarnessRunner} from '../experiments/qwen-voice/harness.mjs';
let complete, closes=0;
class FakeHarness {
  client={start(){},onRequest(fn){this.approval=fn;}};
  async start(){}
  session(){return {run:()=>new Promise(resolve=>{complete=resolve;})};}
  async close(){closes++;complete?.({finishReason:'aborted',finalResponse:'partial'});}
}
test('missing credentials and slash commands never execute',async()=>{
 const runner=new HarnessRunner();assert.match((await runner.run('list')).error,/Key/);
 assert.equal((await runner.run('/permission full')).error,'invalid task');
});
test('single flight, cancelled result suppression and confirmed close',async()=>{
 const runner=new HarnessRunner({key:'test-not-a-real-key',factory:FakeHarness});
 const first=runner.run('count files');
 assert.match((await runner.run('write another file')).error,/已有任务/);
 while(!complete) await new Promise(r=>setTimeout(r,5));
 assert.deepEqual(await runner.harness.client.approval(),{outcome:'rejected'});
 await runner.close();assert.equal((await first).status,'cancelled');
 assert.equal(runner.status().state,'stopped');assert.equal(closes,1);
 assert.ok((await runner.run('again')).error);
});

test('runtime rejection during user stop is cancellation, not execution failure',async()=>{
 let rejectTask;
 class RejectOnClose extends FakeHarness {
   session(){return {run:()=>new Promise((resolve,reject)=>{rejectTask=reject;})};}
   async close(){rejectTask(Error('runtime disconnected'));}
 }
 const notices=[];
 const runner=new HarnessRunner({key:'test',factory:RejectOnClose,notify:message=>notices.push(message)});
 const task=runner.run('create a reading list');
 while(!rejectTask) await new Promise(r=>setTimeout(r,5));
 await runner.close();
 const result=await task;
 assert.equal(result.status,'cancelled');
 assert.match(result.message,/用户主动停止/);
 assert.equal(notices.some(message=>message.includes('执行失败')),false);
 assert.equal(notices.some(message=>message.includes('已返回执行结果')),false);
 assert.equal(runner.state,'stopped');
});
test('runtime rejection without stop remains a real failure',async()=>{
 class FailedHarness extends FakeHarness {
   session(){return {run:async()=>{throw Error('unavailable');}};}
   async close(){}
 }
 const notices=[];
 const runner=new HarnessRunner({key:'test',factory:FailedHarness,notify:message=>notices.push(message)});
 assert.ok((await runner.run('create a study list')).error);
 assert.ok(notices.some(message=>message.includes('执行失败')));
 await runner.close();
});

test('start feedback only fires for an accepted task, not validation failures or duplicates',async()=>{
 let starts=0, finish;
 class StartedHarness extends FakeHarness {
   session(){return {run:()=>new Promise(resolve=>{finish=resolve;})};}
   async close(){}
 }
 const runner=new HarnessRunner({key:'test',factory:StartedHarness,onStart:()=>starts++});
 await runner.run(''); assert.equal(starts,0);
 const task=runner.run('prepare a reading checklist');
 assert.equal(starts,1);
 await runner.run('duplicate'); assert.equal(starts,1);
 while(!finish) await new Promise(r=>setTimeout(r,5));
 finish({finishReason:'completed',finalResponse:'done'}); await task;
 await runner.close(); await runner.run('after stop'); assert.equal(starts,1);
});
