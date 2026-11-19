// Uses a temporary Harness home and local directory operations only; no model request.
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(path.join(os.tmpdir(),'meowvis-session-sdk-'));
const options={dshHome:path.join(root,'home'),cwd:root,processCwd:root,env:{PATH:process.env.PATH,HOME:root,DEEPSEEK_API_KEY:'synthetic-not-a-real-key',DSH_TELEMETRY_MODE:'DISABLED'},provider:'deepseek-official',model:'deepseek-v4-flash',initializeTimeoutMs:30000};
let first,second;
try {
 first=new DeepSeekHarness(options);await first.start();const session=first.session();await session.getWorkingDirectory();const id=session.id;
 await first.close();first=null;second=new DeepSeekHarness(options);const restored=await second.resumeSession(id);
 assert.equal(restored.id,id);assert.equal(await restored.getWorkingDirectory(),root);
 console.log('PASS: real Harness restored the same persisted session and workspace without a model request');
}finally{await first?.close();await second?.close();await rm(root,{recursive:true,force:true});}
