import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateWiki} from '../desktop-runtime/wiki-validation.mjs';
test('GUI Python missing YAML falls back to an installed compatible interpreter',async()=>{
 const calls=[];await validateWiki('/fixture/lint.py','/fixture',async(bin,args)=>{calls.push([bin,args]);if(bin!=='/Library/Frameworks/Python.framework/Versions/Current/bin/python3')throw Error('unavailable');return {stdout:'检查 4 个页面，发现 0 条问题。'};});
 assert.equal(calls.at(-1)[1][0],'/fixture/lint.py');
});
test('missing dependency is distinguished from invalid Wiki structure',async()=>{
 await assert.rejects(validateWiki('/fixture/lint.py','/fixture',async()=>{throw Error('missing yaml');}),/未找到安装了 PyYAML/);
 await assert.rejects(validateWiki('/fixture/lint.py','/fixture',async(_bin,args)=>{if(args[0]==='-c')return {};throw Object.assign(Error('lint'),{stdout:'检查 4 个页面，发现 2 条问题。'});}),/结构检查发现问题/);
 await assert.rejects(validateWiki('/fixture/lint.py','/fixture',async(_bin,args)=>{if(args[0]==='-c')return {};throw Error('timeout');}),/运行失败或超时/);
});
