import {automaticImport,confirmationReceipt} from './import-auto.mjs';
import * as store from './import-store.mjs';
import {generate} from './import-model.mjs';
let input='';
try {
 for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>256*1024)throw Error('请求过大');}
 const {root,action,payload:p={},key}=JSON.parse(input);
 let result;
 switch(action){
 case 'resolve':{let b=await store.commit(root,p.id,p.revision,p.selected,p.selected);try{b=await store.refresh(root,p.id);}catch{}result=confirmationReceipt(b);break;}
 case 'auto':result=await automaticImport(root,p,key);break;
 case 'sources':result=await store.sources(root,p);break;
 case 'batches':result=await store.batches(root);break;
 case 'snapshot':result=await store.snapshot(root,p.selection,p.scope);break;
 case 'load':result=await store.loadBatch(root,p.id);break;
 case 'generate':if(p.consent!==true)throw Error('请先确认本次模型处理授权');result=await generate(root,await store.loadBatch(root,p.id),key);break;
 case 'edit':result=await store.editCandidate(root,p.id,p.revision,p.candidateId,p.patch);break;
 case 'commit':result=await store.commit(root,p.id,p.revision,p.selected,p.risks);try{result=await store.refresh(root,p.id);}catch{result.lastReceipt.search='failed';}break;
 case 'skip':result=await store.skip(root,p.id,p.revision,p.selected);break;
 case 'revoke':result=await store.revoke(root,p.id,p.revision,p.candidateId);break;
 case 'refresh':result=await store.refresh(root,p.id);break;
 default:throw Error('不支持的入库动作');
 }
 process.stdout.write(JSON.stringify({ok:true,result}));
} catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
