import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import test from 'node:test';
import {WebSocket} from 'ws';

test('desktop bridge requires origin and capability token, then shuts down on parent EOF',async()=>{
 const child=spawn('runtime/qwen-node/node_modules/.bin/node',['experiments/qwen-voice/server.mjs'],{env:{...process.env,QWEN_DESKTOP:'1'},stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');
 const lines=createInterface({input:child.stdout});
 try {
   const [line]=await once(lines,'line',{signal:AbortSignal.timeout(10000)});
   const {url}=JSON.parse(line);
   async function rejected(target,origin) {
     const ws=new WebSocket(target,{origin});
     ws.on('error',()=>{});
     await once(ws,'close',{signal:AbortSignal.timeout(3000)}).catch(error=>{if(error.name==='AbortError')throw error;});
     assert.notEqual(ws.readyState,WebSocket.OPEN);
   }
   await rejected(url.replace(/token=.*/, 'token=invalid'),'tauri://localhost');
   await rejected(url,'http://untrusted.example');
   const ws=new WebSocket(url,{origin:'tauri://localhost'});
   await once(ws,'open',{signal:AbortSignal.timeout(3000)});
   const message=once(ws,'message',{signal:AbortSignal.timeout(3000)});
   ws.send(JSON.stringify({type:'connect'}));
   assert.equal(JSON.parse((await message)[0]).type,'bridge.error');
   ws.close();
   child.stdin.end();
   const [code]=await exited;
   assert.equal(code,0);
 } finally {lines.close();child.kill();}
});
