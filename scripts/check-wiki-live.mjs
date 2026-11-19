import {greetingEvents} from '../experiments/qwen-voice/conversation.mjs';
// Explicit opt-in live evaluation. The key arrives on stdin and is never written.
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {wikiFixture} from '../tests/fixtures/wiki.mjs';
const stdin=createInterface({input:process.stdin});
const [line]=await once(stdin,'line');stdin.close();const key=line.trim();
const fixture=await wikiFixture();
try {
 for(const [question,expected,required] of [
  ['你记得我们家猫的名字吗？',/云朵.*山竹|山竹.*云朵/s,'wiki_profile'],
  ['咖啡机多久清洁一次，清洁片放哪儿？',/六周|6周/,'wiki_read'],
  ['家里的烤箱是哪一年买的？',/未记录|没有.*记录|未.*记载|没有找到|尚未|未找到|没找到|没有.*相关/s,'wiki_index'],
  ['我之前登记的课程安排是什么？',/缺失|找不到|无法|读取|不存在|打不开/,'wiki_read'],
 ].filter(row=>!process.env.WIKI_EVAL_FOCUS || row[0].includes(process.env.WIKI_EVAL_FOCUS))) {
  const child=spawn('runtime/qwen-node/node_modules/.bin/node',['experiments/qwen-voice/server.mjs'],{env:{...process.env,QWEN_DESKTOP:'1',QWEN_WORKSPACE:fixture.root,QWEN_HARNESS_HOME:path.join(fixture.root,'harness-home'),QWEN_WIKI_BIN:path.resolve('src-tauri/target/debug/meowvis-desktop')},stdio:['pipe','pipe','pipe']});
  const exit=once(child,'exit');const lines=createInterface({input:child.stdout});
  let ws;
  try {
   const [ready]=await once(lines,'line',{signal:AbortSignal.timeout(10000)});
   ws=new WebSocket(JSON.parse(ready).url,{origin:'tauri://localhost'});
   const calls=[],answers=[];let text='',turnHadTool=false,followed=false,greeting=process.env.QWEN_EVAL_GREET==='1',audioBytes=0;
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('live evaluation timed out')),90000);
    const finish=(error)=>{clearTimeout(timer);error?reject(error):resolve();};
    ws.on('open',()=>ws.send(JSON.stringify({type:'connect',key,region:'qianwen',model:'qwen-audio-3.1-realtime-plus',voice:'longanqian_v3.1',mode:'smart_turn_v2',memoryEnabled:true})));
    ws.on('error',()=>finish(Error('bridge connection failed')));
    ws.on('message',raw=>{
     const e=JSON.parse(raw);
     if(e.type==='session.updated') {
      if(greeting) {for(const event of greetingEvents())ws.send(JSON.stringify(event));return;}
      ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:question}]}}));
      ws.send(JSON.stringify({type:'response.create'}));
     }
     if(e.type==='response.created'){turnHadTool=false;text='';audioBytes=0;}
     if(e.type==='response.audio.delta')audioBytes+=Buffer.from(e.delta,'base64').length;
     if(e.type==='response.function_call_arguments.done'){calls.push({name:e.name,args:JSON.parse(e.arguments)});turnHadTool=true;}
     if(e.type==='response.audio_transcript.done')text+=e.transcript;
     if(e.type==='error'||e.type==='bridge.error')finish(Error(e.message||e.error?.message||'upstream error'));
     if(e.type==='response.done'&&!turnHadTool&&text) {
      if(greeting) {
       assert.ok(audioBytes>0,'greeting must include audio');
       assert.equal(calls.length,0,'greeting must not query private records');
       console.log(JSON.stringify({greeting:text,audioBytes}));greeting=false;
       ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:question}]}}));
       ws.send(JSON.stringify({type:'response.create'}));return;
      }

      if(question.includes('清洁片')&&!followed) {
       answers.push(text);followed=true;
       ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'那它放在哪一层来着？'}]}}));
       ws.send(JSON.stringify({type:'response.create'}));
      } else finish();
     }
    });
   });
   if(answers.length){assert.match(text,/第二层|2层/);answers.push(text);text=answers.join('\n追问回答：');}
   console.log(JSON.stringify({question,calls,answer:text}));
   assert.ok(calls.some(c=>c.name==='wiki_index'),'model must read index');
   assert.ok(calls.some(c=>c.name===required),'model must read evidence');
   assert.match(text,expected);
   if(process.env.QWEN_EVAL_NATURAL==='1') assert.doesNotMatch(text,/来源[：:]|根据档案|查阅|检索/);
   if(question.includes('烤箱')) assert.ok(calls.filter(c=>c.name==='wiki_profile' && c.args.section!=='--list').every(c=>c.args.section==='生活'),'must not inspect unrelated personal chapters');
   if(question.includes('清洁片'))assert.match(text,/蓝色柜子/);
  } finally {ws?.close();child.stdin.end();await Promise.race([exit,new Promise(resolve=>setTimeout(resolve,3000))]);child.kill();lines.close();}
 }
} finally {await fixture.cleanup();}
