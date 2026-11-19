import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WikiReader} from '../experiments/qwen-voice/wiki.mjs';
import {wikiFixture} from './fixtures/wiki.mjs';

test('without consent no local file is read or sent',async()=>{
 const wiki=new WikiReader({binary:'unused',workspace:'unused',run:()=>assert.fail('must not read')});
 assert.equal((await wiki.call('wiki_index')).status,'permission_required');
});
test('native Wiki tools read sources across topics, isolate chapters, and distinguish failures',async()=>{
 const fixture=await wikiFixture();
 const wiki=new WikiReader({enabled:true,binary:path.resolve('src-tauri/target/debug/meowvis-desktop'),workspace:fixture.root});
 try {
  const index=await wiki.call('wiki_index');assert.equal(index.ok,true);assert.match(index.content,/咖啡机维护/);
  const sections=await wiki.call('wiki_profile',{section:'--list',purpose:'定位所需章节'});assert.match(sections.content,/我的宠物/);assert.doesNotMatch(sections.content,/云朵/);
  const pets=await wiki.call('wiki_profile',{section:'我的宠物',purpose:'回答宠物名字'});assert.match(pets.content,/云朵/);assert.match(pets.content,/来源：/);assert.doesNotMatch(pets.content,/合成私人字段/);
  const machine=await wiki.call('wiki_read',{page:'物品与设备/咖啡机维护.md'});assert.match(machine.content,/六周/);
  const location=await wiki.call('wiki_read',{page:'物品与设备/耗材位置.md'});assert.match(location.content,/蓝色柜子/);
  assert.equal((await wiki.call('wiki_read',{page:'学习/课程安排.md'})).status,'read_error');
  assert.equal((await wiki.call('wiki_profile',{section:'我的宠物',purpose:'无关兜底'})).status,'read_error');
  wiki.resetTurn();
  assert.equal((await wiki.call('wiki_read',{page:'家庭日常/个人与家庭档案.md'})).status,'use_profile_tool');
  assert.equal((await wiki.call('wiki_read',{page:'../raw/记录.md'})).status,'invalid_request');
  assert.equal((await wiki.call('wiki_search',{query:'不存在的合成关键词'})).status,'no_search_matches');
  assert.equal((await wiki.call('wiki_search',{query:'另一个不存在词'})).status,'search_exhausted');
  assert.equal((await wiki.call('wiki_profile',{section:'生活',purpose:'试图继续翻阅'})).status,'search_exhausted');
  wiki.resetTurn();
  assert.match((await wiki.call('wiki_search',{query:'清洁片'})).content,/来源：/);
 } finally {await fixture.cleanup();}
});
