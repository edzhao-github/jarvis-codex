import { ResponseControl, audioQueueOverflow } from './playback.mjs';
let responses = new ResponseControl();
let userSpeaking = false, startCuePending = false;
function playStartCue() {
  if (!context || !startCuePending || userSpeaking || playing.size) return;
  startCuePending = false;
  const oscillator = context.createOscillator(), gain = context.createGain();
  const now = context.currentTime;
  oscillator.frequency.setValueAtTime(660, now);
  oscillator.frequency.setValueAtTime(880, now + 0.09);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.08, now + 0.015);
  gain.gain.linearRampToValueAtTime(0, now + 0.18);
  oscillator.connect(gain).connect(context.destination);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(now); oscillator.stop(now + 0.2);
}
const $ = id => document.getElementById(id);
let ws, context, stream, capture, source, mute, nextTime = 0, suppressed = false, endSpeech = 0, firstAudio = false, generation = 0, activeResponse;
const playing = new Set();
const blockedResponses = new Set();
function log(text) { $('log').textContent = ($('log').textContent + '\n' + text).slice(-16000); }
function send(event) { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 512000) { stop(); log('网络过慢，已断开'); return; } ws.send(JSON.stringify(event)); } }
function clearAudio() { for (const node of playing) { try { node.stop(); } catch {} } playing.clear(); send({type:'bridge.playback',active:false}); nextTime = 0; suppressed = true; if (activeResponse) blockedResponses.add(activeResponse); }
function stop() {
  generation++; startCuePending = false; userSpeaking = false; responses = new ResponseControl(); activeResponse = undefined; blockedResponses.clear(); const previous = ws; ws = null; previous?.close(); clearAudio();
  capture?.disconnect(); source?.disconnect(); mute?.disconnect(); stream?.getTracks().forEach(t => t.stop()); void context?.close();
  context = stream = capture = source = mute = null;
  $('start').disabled = false; $('stop').disabled = $('interrupt').disabled = true; $('status').textContent = '已结束';
}
function audio(event) {
  if (!context || suppressed || blockedResponses.has(event.response_id)) return;
  const bytes = Uint8Array.from(atob(event.delta), c => c.charCodeAt(0));
  const pcm = new DataView(bytes.buffer); const buffer = context.createBuffer(1, bytes.length / 2, 24000);
  const channel = buffer.getChannelData(0); for (let i=0; i<channel.length; i++) channel[i] = pcm.getInt16(i*2,true)/32768;
  const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
  nextTime = Math.max(context.currentTime + 0.025, nextTime);
  if (!firstAudio && endSpeech) { firstAudio = true; $('metric').textContent = `首段播放延迟（代理指标）：${Math.round(performance.now()-endSpeech + (nextTime-context.currentTime)*1000)} ms`; }
  if (audioQueueOverflow(nextTime, context.currentTime, buffer.duration)) { clearAudio(); responses.cancel(send); log('播放积压过多，已取消回复'); return; }
  if (!playing.size) send({type:'bridge.playback',active:true});
  playing.add(node); node.onended = () => { playing.delete(node); if (!playing.size) { send({type:'bridge.playback',active:false}); playStartCue(); } }; node.start(nextTime); nextTime += buffer.duration;
}
$('start').onclick = async () => {
  const key = $('key').value.trim(); const workspace = $('workspace').value.trim();
  if (!key || ($('region').value !== 'qianwen' && !workspace)) { log('先填写密钥和 Workspace ID'); return; }
  $('start').disabled = true; $('stop').disabled = false; const own = ++generation;
  try {
    context = new AudioContext({sampleRate:16000}); await context.resume();
    const mic = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
    if (own !== generation) { mic.getTracks().forEach(t=>t.stop()); return; }
    stream = mic; await context.audioWorklet.addModule('/capture.js'); if (own !== generation) return;
    ws = new WebSocket(`ws://${location.host}/voice`); $('status').textContent = '正在连接';
    ws.onopen = () => { send({type:'connect',deepseekKey:$('deepseekKey').value.trim(),deepseekModel:$('deepseekModel').value.trim(),key,workspace,region:$('region').value,model:$('model').value.trim(),voice:$('voice').value.trim(),mode:$('mode').value}); $('key').value = ''; $('deepseekKey').value = ''; };
    ws.onmessage = ({data}) => {
      if (own !== generation) return;
      const e = JSON.parse(data);
      responses.event(e);
      if (responses.isCancelRace(e)) { log('回复已结束，无需再次取消；通话继续'); return; }
      if (e.type === 'session.updated' && !capture) {
        source = context.createMediaStreamSource(stream); capture = new AudioWorkletNode(context,'capture'); mute=context.createGain(); mute.gain.value=0;
        capture.port.onmessage = ({data}) => { if (own !== generation) return; const bytes=new Uint8Array(data); send({type:'input_audio_buffer.append',audio:btoa(String.fromCharCode(...bytes))}); };
        source.connect(capture).connect(mute).connect(context.destination); $('status').textContent='通话中'; $('interrupt').disabled=false; log('会话已就绪');
      } else if(e.type==='input_audio_buffer.speech_started') { userSpeaking=true; clearAudio(); endSpeech=0; }
      else if(e.type==='input_audio_buffer.speech_stopped') { userSpeaking=false; playStartCue(); endSpeech=performance.now(); firstAudio=false; }
      else if(e.type==='response.created') { activeResponse=e.response?.id; suppressed=false; }
      else if(e.type==='response.audio.delta') audio(e);
      else if(e.type==='response.audio_transcript.done') log('AI：'+e.transcript);
      else if(e.type==='conversation.item.input_audio_transcription.completed') log('你：'+e.transcript);
      else if(e.type==='bridge.task_settled') { startCuePending=false; }
      else if(e.type==='bridge.task_started') { startCuePending=true; playStartCue(); log('已收到，任务开始处理'); }
      else if(e.type==='bridge.tool') log(e.message);
      else if(e.type==='error' || e.type==='bridge.error') { log('错误：'+(e.message || e.error?.message || '未知错误')); stop(); }
    };
    ws.onclose=()=>{if(own===generation){stop();log('连接已关闭');}};
    ws.onerror=()=>{if(own===generation){stop();log('连接失败');}};
  } catch(e) { if(own===generation){stop();log(e.message);} }
};
$('stop').onclick=stop;
$('interrupt').onclick=()=>{clearAudio();responses.cancel(send);log('已清空本机播放队列并请求取消回复');};
$('text').onsubmit=e=>{e.preventDefault();const text=$('message').value.trim();if(!capture || !text)return;clearAudio();send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});send({type:'response.create'});log('你：'+text);$('message').value='';endSpeech=performance.now();firstAudio=false;};
window.addEventListener('pagehide',stop);

$('stopTask').onclick=()=>send({type:'bridge.stop_task'});
