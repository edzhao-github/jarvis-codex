import { mkdir } from 'node:fs/promises';
import path from 'node:path';
export class HarnessRunner {
  constructor({ key, model = 'deepseek-v4-flash', notify = () => {}, onStart = () => {}, workspace, home, factory, conversation } = {}) {
    Object.assign(this, { key, model, notify, onStart, factory, conversation });
    this.workspace = path.resolve(workspace || 'runtime/qwen-harness/workspace');
    this.home = path.resolve(home || 'runtime/qwen-harness/home');
    this.state = 'idle'; this.closed = false;
  }
  async run(prompt) {
    if (this.closed) return { error: 'execution session closed' };
    if (this.state !== 'idle') return { error: '已有任务正在执行，请查询状态或先停止；没有重复执行。' };
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 || prompt.trimStart().startsWith('/')) return { error: 'invalid task' };
    if (!this.key) return { error: '尚未提供 DeepSeek API Key，未执行任务。' };
    this.state = 'running'; this.onStart(); this.notify('Harness 正在执行任务');
    try {
      if(this.conversation)await this.conversation.task({state:'running',request:prompt.slice(0,6000)});
      if (!this.harness) {
        await mkdir(this.workspace, {recursive:true}); await mkdir(this.home, {recursive:true});
        const Factory = this.factory || (await import('@deepseek-ai/dsh-sdk-client')).DeepSeekHarness;
        if (this.closed) return this.cancelledResult();
        const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
        Object.assign(env,{DEEPSEEK_API_KEY:this.key,DSH_PERMISSION_MODE:'workspace-write',DSH_TELEMETRY_MODE:'DISABLED'});
        this.harness = new Factory({dshHome:this.home,cwd:this.workspace,processCwd:this.workspace,env,provider:'deepseek-official',model:this.model,approvalRequests:true,initializeTimeoutMs:120000,onUserQuestion:async()=>{this.notify('任务需要进一步信息，请在下一轮明确补充；本次提问已取消。');return {cancelled:true};}});
        this.harness.client.start();
        this.harness.client.onRequest(async()=>{this.notify('任务请求额外权限，测试入口已拒绝。');return {outcome:'rejected'};});
        await this.harness.start();
        const savedId=this.conversation?.data.harnessId;
        if(savedId){
          try{this.session=await this.harness.resumeSession(savedId);}
          catch{this.restoreFailed=true;throw Error('session restore failed');}
        } else this.session = this.harness.session();
      }
      if (this.closed) return this.cancelledResult();
      if(this.restoreFailed)throw Error('session restore failed');
      if(this.conversation)await this.conversation.bindHarness(this.session.id);
      if(this.closed)return this.cancelledResult();
      const result = await this.session.run(prompt);
      if (this.closed) return this.cancelledResult();
      if(this.conversation)await this.conversation.task({state:result.finishReason==='error'?'failed':'returned',finishReason:result.finishReason,request:prompt.slice(0,6000),result:String(result.finalResponse||'').slice(-6000)});
      this.notify('Harness 已返回执行结果');
      return {finishReason:result.finishReason,text:result.finalResponse,workspace:this.workspace};
    } catch {
      if (this.closed) return this.cancelledResult();
      if(this.restoreFailed){if(this.conversation)await this.conversation.task({state:'restore-failed',request:prompt.slice(0,6000),result:'历史会话恢复失败，本次未执行任务'});this.notify('历史任务会话恢复失败，未创建新会话或重跑任务。请重连后再试，或明确开启新会话。');return {error:'task session restoration failed; no task executed; reconnect or explicitly start a new conversation'};}
      if(this.conversation)await this.conversation.task({state:'failed',request:prompt.slice(0,6000)});
      this.notify('Harness 执行失败，请检查模型权限、密钥或运行时安装；未自动重试。');
      return {error:'Harness execution failed; do not claim success or retry automatically'};
    } finally { if (!this.closed) this.state='idle'; }
  }
  cancelledResult() {
    return {status:'cancelled',state:this.state,message:'用户主动停止了任务，不是执行故障。不得自动重试或承诺重新执行，简短确认停止并等待用户下一条明确指令。不要宣称任务成功或未创建任何文件；停止前可能已完成部分操作，不会自动撤销。停止是否确认以运行时状态为准。收到用户明确的新任务指令后，可以恢复执行会话。'};
  }
  status() { return {state:this.state,workspace:this.workspace}; }
  close() {
    return this.closing ||= this.dispose();
  }
  async dispose() {
    const wasRunning=this.state==='running';
    this.closed=true; this.state='stopping';
    try { await this.harness?.close(); if(wasRunning&&this.conversation)await this.conversation.task({...this.conversation.data.task,state:'stopped'}); this.state='stopped'; this.notify('Harness 运行时已停止（已完成的文件操作不会撤销）'); }
    catch { this.state='stop-failed'; this.notify('未能确认 Harness 已停止，请检查进程。'); throw Error('停止未确认'); }
    finally { this.key=undefined; }
  }
}
export const harnessTools = [
  {type:'function',function:{name:'execute_task',description:'将用户明确要求的实际文件处理或分析任务交给 DeepSeek Harness。仅在配置的工作目录内写入，返回前不得宣称完成。执行失败不自动重试。',parameters:{type:'object',properties:{task:{type:'string'}},required:['task']}}},
  {type:'function',function:{name:'task_status',description:'查询当前真实任务运行状态，不启动新任务。',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'stop_task',description:'用户明确要求停止任务时，关闭执行引擎。不会撤销已完成的操作。',parameters:{type:'object',properties:{}}}}
];
