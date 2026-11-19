import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyScheduler } from '../experiments/qwen-voice/scheduler.mjs';
function setup() {
  const sent = []; let timer;
  const q = new ReplyScheduler(e => sent.push(e), {schedule: fn => { timer = fn; return 1; }, cancel: () => { timer = undefined; }});
  return {q,sent,tick:()=>{const f=timer;timer=undefined;f?.();}};
}
const result = label => ({type:'function_call_output',call_id:label,output:JSON.stringify({label})});
const response = (type,id) => ({type,response:{id}});
test('tool result cannot enter or replace an unfinished spoken user turn',()=>{
  const {q,sent,tick}=setup();
  q.event({type:'input_audio_buffer.speech_started'});q.tool(result('旅行'));
  tick();assert.equal(sent.length,0);
  q.event({type:'input_audio_buffer.speech_stopped'});tick();assert.equal(sent.length,0);
  q.event(response('response.created','answer'));tick();assert.equal(sent.length,0);
  q.event({type:'bridge.playback',active:true});q.event(response('response.done','answer'));tick();assert.equal(sent.length,0);
  q.event({type:'bridge.playback',active:false});tick();
  assert.deepEqual(sent.map(e=>e.type),['conversation.item.create','response.create']);
});
test('new speech during the quiet gap wins, including late completion of old response',()=>{
  const {q,sent,tick}=setup();
  q.tool(result('天气'));q.event({type:'input_audio_buffer.speech_started'});
  q.event(response('response.done','old'));tick();assert.equal(sent.length,0);
  q.event({type:'input_audio_buffer.speech_stopped'});q.event(response('response.created','new'));
  q.event(response('response.done','new'));tick();assert.equal(sent.length,2);
});
test('overlapping response completion does not release queued tools early',()=>{
  const {q,sent,tick}=setup();
  q.event(response('response.created','a'));q.event(response('response.created','b'));
  q.tool(result('报表'));q.event(response('response.done','a'));tick();assert.equal(sent.length,0);
  q.event(response('response.done','b'));tick();assert.equal(sent.length,2);
});
test('typed question has priority and multiple completions batch into one reply',()=>{
  const {q,sent,tick}=setup();q.tool(result('一'));q.userText();q.tool(result('二'));tick();assert.equal(sent.length,0);
  q.event(response('response.created','text'));q.event(response('response.done','text'));tick();
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);
  assert.equal(sent.filter(e=>e.type==='conversation.item.create').length,2);
});
test('disconnect clears pending and late completions',()=>{
  const {q,sent,tick}=setup();q.tool(result('cleanup'));q.close();tick();q.tool(result('late'));tick();assert.equal(sent.length,0);
});
