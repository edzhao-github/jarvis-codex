import {ConversationSessions,sessionTools} from './sessions.mjs';
const importTool={type:'function',function:{name:'memory_import',description:'仅当用户明确要求把聊天入库/整理保存时调用。直接整理指定时间范围，保存明确且无冲突的内容，不打开选择面板。只想查看提案时不得调用。今天用 today，其他明确日期用 range（带时区）。不明确的范围先问清。',parameters:{type:'object',properties:{scope:{type:'string'},period:{type:'string',enum:['today','range']},from:{type:'string'},to:{type:'string'}},required:['scope','period']}}};
const confirmImportTool={type:'function',function:{name:'memory_import_confirm',description:'仅在用户明确回答同意上次入库结果中列明的待确认事项后调用。只确认用户同意的条目，不猜测授权。',parameters:{type:'object',properties:{batchId:{type:'string'},revision:{type:'number'},selected:{type:'array',items:{type:'string'}}},required:['batchId','revision','selected']}}};
import {WikiReader, wikiTools, wikiInstructions} from './wiki.mjs';
import { HarnessRunner, harnessTools } from './harness.mjs';
import { ReplyScheduler } from './scheduler.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
const desktop = process.env.QWEN_DESKTOP === '1';
const accessToken = desktop ? randomBytes(32).toString('hex') : '';
const desktopOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420', 'http://127.0.0.1:1420']);
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
let port = desktop ? 0 : Number(process.env.QWEN_TEST_PORT || 1431);
const origin = `http://127.0.0.1:${port}`;
const files = { '/playback.mjs': ['playback.mjs', 'text/javascript'], '/': ['index.html', 'text/html'], '/client.js': ['client.js', 'text/javascript'], '/capture.js': ['capture.js', 'text/javascript'] };
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET' || !files[req.url]) { res.writeHead(403).end(); return; }
  const [file, type] = files[req.url];
  try { res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); res.end(await readFile(new URL(file, import.meta.url))); }
  catch { res.writeHead(500).end(); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
let busy = false;
const runners = new Set();
const conversations = new Set();
server.on('upgrade', (req, socket, head) => {
  const authorized = desktop ? desktopOrigins.has(req.headers.origin) && req.url === `/voice?token=${accessToken}` : req.headers.origin === origin && req.url === '/voice';
  if (!authorized || req.headers.host !== `127.0.0.1:${port}` || busy) { socket.destroy(); return; }
  busy = true;
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', client => {
  let upstream, configured = false, runner, runnerFactory, wiki, conversation, switching=false, hasNewInput=false;
  const calls = new Set(), jobs = new Set();
  const scheduler = new ReplyScheduler(event => {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
  });
  const send = event => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
  const importCalls=new Set();
  const timer = setTimeout(() => client.close(), 15_000);
  const lifetime = desktop ? undefined : setTimeout(() => client.close(1000, '30 minute test limit'), 30 * 60_000);
  const persist=promise=>{void promise?.catch(()=>{send({type:'bridge.error',message:'会话记录保存失败，已停止连接以避免丢失上下文。请检查磁盘和文件权限。'});client.close();});};
  client.on('message', async raw => {
    try {
      const event = JSON.parse(raw);
      if (!configured) {
        if (event.type !== 'connect' || !(event.region === 'qianwen' || (/^[a-zA-Z0-9-]+$/.test(event.workspace) && ['cn-beijing', 'ap-southeast-1'].includes(event.region))) || !/^qwen-[a-z0-9.-]+$/.test(event.model) || !event.key?.startsWith('sk-')) throw Error('请填写有效的密钥、地域、Workspace ID 和型号');
        configured = true; clearTimeout(timer);
        if(desktop){
          conversation=await new ConversationSessions({home:process.env.QWEN_HARNESS_HOME,workspace:process.env.QWEN_WORKSPACE}).open();
          conversations.add(conversation);send({type:'bridge.session',...conversation.info()});
        }
        if(client.readyState!==WebSocket.OPEN)return;
        runnerFactory = ()=>new HarnessRunner({conversation,workspace:desktop ? process.env.QWEN_WORKSPACE : undefined,home:desktop ? process.env.QWEN_HARNESS_HOME : undefined,key:event.deepseekKey,model:event.deepseekModel || 'deepseek-v4-flash',onStart:()=>send({type:'bridge.task_started'}),notify:message=>send({type:'bridge.tool',message})});
        runner=runnerFactory();runners.add(runner);
        wiki = new WikiReader({enabled:desktop && event.memoryEnabled === true,binary:process.env.QWEN_WIKI_BIN,workspace:process.env.QWEN_WORKSPACE});
        const host = event.region === 'qianwen' ? 'maas.qianwenaiapi.com' : `${event.workspace}.${event.region}.maas.aliyuncs.com`;
        upstream = new WebSocket(`wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(event.model)}`, { headers: { Authorization: `Bearer ${event.key.trim()}` }, handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024 });
        upstream.on('open', () => upstream.send(JSON.stringify({ type: 'session.update', session: { instructions: (desktop && typeof event.personality === 'string' ? event.personality + '\n' : '') + (desktop ? wikiInstructions : '') + (conversation?.context()||'') + '本应用有持久会话：重新唤醒会续接近期对话和任务历史；只有用户明确要求才开启或切换会话。若用户问之前聊到哪里，根据恢复资料回答，不要猜测或自动执行旧任务。管理会话用 conversation_session。' + `本机当前时间：${new Date().toString()}。` + '用户明确要求整理聊天入库时调用 memory_import，用户的请求即为这次整理保存的授权，不要要求用户打开面板、选消息或逐条确认普通内容。先简短说开始整理，等工具返回后简短报结果；只有返回的待确认事项才提问，并在用户答复后用 memory_import_confirm。不要用 execute_task 整理记忆。语音要像熟悉的伙伴自然接话。新会话尚无用户消息而请求你回应时，用一句简短自然的招呼回应唤醒，不介绍功能、不调用工具，随后等待用户说话。调用 execute_task 或 delay_probe 前，先用一句简短语音确认已收到并将开始处理，再调用工具，不要默默等待结果。不要复述整段任务或在执行前宣称成功。工具返回 cancelled 表示用户主动停止。简短确认停止，不得自行重试、重建任务或承诺重新执行；等待用户下一条明确指令。仅根据工具证据说明结果，不推断文件不存在。', tools: [...(desktop ? [...wikiTools,...sessionTools,importTool,confirmImportTool] : []), ...(event.deepseekKey ? harnessTools : []), {type:'function',function:{name:'delay_probe',description:'仅测试工具等待：等待指定秒数后返回用户提供的标签，不操作任何文件。仅在用户要求测试等待时调用。',parameters:{type:'object',properties:{seconds:{type:'number',minimum:0,maximum:30},label:{type:'string'}},required:['seconds','label']}}}], modalities: ['text', 'audio'], voice: event.voice, turn_detection: { type: event.mode === 'server_vad' ? 'server_vad' : 'smart_turn_v2' } } })));
        upstream.on('message', data => {
          if (client.readyState === WebSocket.OPEN) client.send(data.toString());
          try {
            const e = JSON.parse(data);
            scheduler.event(e);
            if(conversation&&!switching){
              if(e.type==='conversation.item.input_audio_transcription.completed'){hasNewInput=true;persist(conversation.append('user',e.transcript,e.item_id||e.event_id));}
              if(e.type==='response.audio_transcript.done'&&hasNewInput)persist(conversation.append('assistant',e.transcript,e.item_id||e.event_id));
            }
            if(e.type==='input_audio_buffer.speech_started') wiki?.resetTurn();
            if (e.type === 'response.function_call_arguments.done' && !calls.has(e.call_id)) {
              if (!e.call_id) return;
              if (calls.size >= 100) { send({type:'bridge.error',message:'本次会话工具调用已达上限，请重新连接。'}); client.close(); return; }
              calls.add(e.call_id);
              let args; try { args = JSON.parse(e.arguments); } catch { args = {}; }
              if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
              if(desktop&&e.name==='conversation_session'){
                void (async()=>{
                  if(args.action==='list')return {sessions:await conversation.list()};
                  if(!['new','resume'].includes(args.action))return {error:'会话操作无效'};
                  if(runner.state==='running'||importCalls.size||jobs.size)return {error:'当前有任务在处理，先等任务完成；不要丢弃正在执行的工作'};
                  if(switching)return {error:'正在切换会话'};
                  switching=true;
                  try{
                    await runner.close();
                    const info=args.action==='new'?await conversation.create():await conversation.select(args.id);
                    send({type:'bridge.session_reset',...info});return null;
                  }catch(error){switching=false;return {error:String(error.message||error),instruction:'会话切换未完成，不要宣称成功；可重新连接后再试'};}
                })().then(result=>{if(result)scheduler.tool({type:'function_call_output',call_id:e.call_id,output:JSON.stringify(result)});}).catch(()=>{send({type:'bridge.error',message:'无法读写会话记录'});client.close();});return;
              }
              if(desktop && ['memory_import','memory_import_confirm'].includes(e.name)){
                importCalls.add(e.call_id);send({type:'bridge.task_started'});
                send({type:'bridge.import',callId:e.call_id,operation:e.name==='memory_import'?'auto':'confirm',request:args,cutoff:new Date().toISOString()});return;
              }
              if (desktop && wikiTools.some(tool=>tool.function.name===e.name)) {
                send({type:'bridge.memory',status:'reading',message:'正在查阅本地 Wiki'});
                void wiki.call(e.name,args).then(result=>{
                  scheduler.tool({type:'function_call_output',call_id:e.call_id,output:JSON.stringify(result)});
                  const sources = result.ok && e.name !== 'wiki_index' && e.name !== 'wiki_search'
                    ? (result.content?.split('\n').filter(line=>line.startsWith('来源：')) || []) : [];
                  send({type:'bridge.memory',status:result.status,sources,message:result.ok?'Wiki 查询已返回':result.message});
                });
                return;
              }
              if (['execute_task','task_status','stop_task'].includes(e.name)) {
                if(e.name==='execute_task'&&runner.closed&&runner.state==='stopped'){runner=runnerFactory();runners.add(runner);}
                const operation = e.name === 'execute_task' ? runner.run(args.task) : e.name === 'task_status' ? Promise.resolve(runner.status()) : runner.close().then(()=>runner.status());
                operation.finally(()=>{if(e.name === 'execute_task') send({type:'bridge.task_settled'});}).catch(()=>{});
                operation.then(result => scheduler.tool({type:'function_call_output',call_id:e.call_id,output:JSON.stringify(result)})).catch(()=>scheduler.tool({type:'function_call_output',call_id:e.call_id,output:JSON.stringify({error:'operation failed'})}));
                return;
              }
              const valid = e.name === 'delay_probe' && Number.isFinite(args.seconds) && args.seconds >= 0 && args.seconds <= 30 && typeof args.label === 'string' && args.label.length <= 200;
              send({type:'bridge.tool',message:valid ? `等待测试开始：${args.seconds} 秒` : '工具参数无效'});
              if (valid) send({type:'bridge.task_started'});
              const job = setTimeout(() => {
                jobs.delete(job);
                send({type:'bridge.task_settled'});
                if (upstream.readyState !== WebSocket.OPEN) return;
                scheduler.tool({type:'function_call_output',call_id:e.call_id,output:JSON.stringify(valid ? {ok:true,label:args.label,waitedSeconds:args.seconds,simulation:true} : {error:'invalid tool or arguments'})});
                send({type:'bridge.tool',message:'等待测试已返回'});
                // Scheduler waits for the user turn and local playback to finish.
              }, valid ? args.seconds * 1000 : 0);
              jobs.add(job);
            }
          } catch { send({type:'bridge.error',message:'上游事件解析失败'}); client.close(); }
        });
        upstream.on('unexpected-response', (_req, response) => { send({ type: 'bridge.error', message: `服务拒绝连接：HTTP ${response.statusCode}。检查地域、空间、模型权限和密钥。` }); response.resume(); upstream.terminate(); client.close(); });
        upstream.on('error', () => { send({ type: 'bridge.error', message: '上游连接失败，请检查网络和连接配置。' }); client.close(); });
        upstream.on('close', () => client.close());
      } else if (upstream?.readyState === WebSocket.OPEN) {
        if(event.type==='bridge.import_result'){if(importCalls.delete(event.callId)){send({type:'bridge.task_settled'});scheduler.tool({type:'function_call_output',call_id:event.callId,output:JSON.stringify(event.result)});}return;}
        if (event.type === 'bridge.stop_task') { send({type:'bridge.task_settled'}); void runner?.close().catch(()=>{}); return; }
        if (event.type === 'bridge.playback' && typeof event.active === 'boolean') { scheduler.event(event); return; }
        if (event.type === 'conversation.item.create' && event.item?.role === 'user') {scheduler.userText();wiki?.resetTurn();if(conversation&&!switching&&!event.item?.content?.some(c=>c.text?.startsWith('[应用事件'))){hasNewInput=true;persist(conversation.append('user',(event.item.content||[]).map(c=>c.text||'').join('\n'),event.item.id));}}
        if (upstream.bufferedAmount > 512 * 1024) throw Error('网络积压过多，已停止测试，请重新连接');
        const allowed = ['input_audio_buffer.append', 'response.cancel', 'conversation.item.create', 'response.create'];
        if (allowed.includes(event.type)) upstream.send(JSON.stringify(event));
      }
    } catch (error) { send({ type: 'bridge.error', message: error.message }); client.close(); }
  });
  client.on('error', () => client.close());
  client.on('close', () => { scheduler.close(); void (runner?.close() || Promise.resolve()).then(()=>conversation?.flush()).catch(()=>{}).finally(()=>{busy=false;}); for (const job of jobs) clearTimeout(job); clearTimeout(timer); clearTimeout(lifetime); upstream?.terminate(); });
});
server.listen(port, '127.0.0.1', () => {
  port = server.address().port;
  console.log(desktop ? JSON.stringify({url:`ws://127.0.0.1:${port}/voice?token=${accessToken}`}) : `Qwen voice lab: ${origin} (microphone starts only after Connect)`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  for (const socket of wss.clients) socket.close();
  server.close();
  const results = await Promise.allSettled([...runners].map(r=>r.close()));
  const saved=await Promise.allSettled([...conversations].map(c=>c.flush()));
  process.exit([...results,...saved].some(r=>r.status === 'rejected') ? 1 : 0);
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, shutdown);
if (desktop) { process.stdin.resume(); process.stdin.on('end', shutdown); }
