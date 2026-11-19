import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const local = path.resolve('runtime/qwen-node/node_modules/.bin/node');
const current = process.versions.node.split('.').map(Number);
const binary = current[0] > 24 || (current[0] === 24 && current[1] >= 9) ? process.execPath : existsSync(local) ? local : null;
if (!binary) { console.error('Harness needs Node >=24.9. Install an isolated runtime: npm install --prefix runtime/qwen-node --no-save node@24'); process.exit(1); }
const child = spawn(binary, ['experiments/qwen-voice/server.mjs'], {stdio:'inherit'});
for (const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>child.kill(sig));
child.on('exit', code=>process.exit(code ?? 1));
child.on('error',()=>{console.error('Unable to launch voice server');process.exit(1);});
