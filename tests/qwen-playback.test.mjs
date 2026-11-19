import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ResponseControl,audioQueueOverflow} from '../experiments/qwen-voice/playback.mjs';
test('normal long speech is buffered with a finite memory bound',()=>{
 assert.equal(audioQueueOverflow(25,0,1),false);
 assert.equal(audioQueueOverflow(119,0,2),true);
});
test('completed generation may still play but must not be cancelled',()=>{
 const control=new ResponseControl();
 control.event({type:'response.created',response:{id:'one'}});
 control.event({type:'response.done',response:{id:'one'}});
 assert.equal(control.cancel(()=>assert.fail('unexpected cancellation')),false);
});
test('cancellation races are recoverable without hiding other errors',()=>{
 const control=new ResponseControl(),sent=[];
 control.event({type:'response.created',response:{id:'two'}});
 assert.equal(control.cancel(e=>sent.push(e)),true);
 assert.equal(control.cancel(()=>assert.fail()),false);
 assert.equal(sent.length,1);
 assert.equal(control.isCancelRace({type:'error',error:{message:'Invalid key'}}),false);
 assert.equal(control.isCancelRace({type:'error',error:{message:'Conversation has no active response.'}}),true);
 assert.equal(control.isCancelRace({type:'error',error:{message:'Conversation has no active response.'}}),false);
});
