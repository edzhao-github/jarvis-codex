import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export async function validateWiki(script,cwd,run=execute){
 const candidates=['python3','/opt/homebrew/bin/python3','/usr/local/bin/python3','/Library/Frameworks/Python.framework/Versions/Current/bin/python3','/usr/bin/python3'];
 let python;
 for(const candidate of candidates){
  try{await run(candidate,['-c','import yaml; from zoneinfo import ZoneInfo'],{timeout:10000,maxBuffer:65536});python=candidate;break;}catch{}
 }
 if(!python)throw Error('Wiki 检查工具无法运行：未找到安装了 PyYAML 的 Python 3；已保留入库恢复记录，不能据此判定 Wiki 结构有问题');
 try{await run(python,[script],{cwd,timeout:30000,maxBuffer:1024*1024});}
 catch(e){
  const output=String(e.stdout||'');
  if(/检查 \d+ 个页面，发现 [1-9]\d* 条问题/.test(output))throw Error('Wiki 结构检查发现问题：请查看记忆/wiki/维护/报告中的最新 lint 报告；已保留恢复记录');
  throw Error('Wiki 检查工具运行失败或超时；已保留入库恢复记录，尚不能判定页面结构是否正确');
 }
}
