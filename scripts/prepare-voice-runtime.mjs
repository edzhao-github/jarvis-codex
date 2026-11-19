import {mkdir,copyFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root = path.resolve('runtime/desktop-voice');
await mkdir(root,{recursive:true});
await writeFile(path.join(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@deepseek-ai/dsh-sdk-client':'0.2.2-rc.5',ws:'8.23.0'}},null,2));
const install=spawnSync('npm',['install','--omit=dev','--no-audit','--no-fund'],{cwd:root,stdio:'inherit'});
if(install.status!==0) process.exit(install.status||1);
await copyFile('runtime/qwen-node/node_modules/node/bin/node',path.join(root,'node'));
await chmod(path.join(root,'node'),0o755);
for(const file of ['server.mjs','harness.mjs','scheduler.mjs','wiki.mjs','sessions.mjs']) await copyFile(`experiments/qwen-voice/${file}`,path.join(root,file));
console.log('Desktop voice runtime prepared');

for(const file of ['import-store.mjs','import-model.mjs','import-cli.mjs','import-auto.mjs','wiki-validation.mjs']) await copyFile(`desktop-runtime/${file}`,path.join(root,file));
