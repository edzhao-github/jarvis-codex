import { greetingEvents } from '../experiments/qwen-voice/conversation.mjs';
import { ResponseControl, audioQueueOverflow } from '../experiments/qwen-voice/playback.mjs';
import captureUrl from '../experiments/qwen-voice/capture.js?url&no-inline';

type Hooks = {
  event: (event: any) => void;
  playback: (active: boolean) => void;
  closed: (error?: string) => void;
};
export class QwenVoice {
  private ws?: WebSocket;
  private context?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private silence?: GainNode;
  private analyser?: AnalyserNode;
  private playbackAnalyser?: AnalyserNode;
  private nodes = new Set<AudioBufferSourceNode>();
  private blocked = new Set<string>();
  private responses = new ResponseControl();
  private nextTime = 0;
  private responseId?: string;
  private suppressed = false;
  private speaking = false;
  private cuePending = false;
  private closed = false;
  private ready = false;
  private localReply = false;
  private failStart?: (reason: Error) => void;
  constructor(private hooks: Hooks) {}
  get active() { return this.ready && !this.closed; }
  get meters() { return {microphone:this.analyser,remote:this.playbackAnalyser}; }
  private send(e: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 512000) { this.fail('网络积压过多，请重新连接'); return; }
    this.ws.send(JSON.stringify(e));
  }
  async start(url: string, config: Record<string,unknown>) {
    this.context = new AudioContext({sampleRate:16000});
    await this.context.resume();
    const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
    if(this.closed) { stream.getTracks().forEach(t=>t.stop()); throw Error('连接已取消'); }
    this.stream=stream;
    await this.context.audioWorklet.addModule(captureUrl);
    if(this.closed) throw Error('连接已取消');
    this.analyser=this.context.createAnalyser(); this.analyser.fftSize=1024;
    this.playbackAnalyser=this.context.createAnalyser(); this.playbackAnalyser.fftSize=1024;
    this.playbackAnalyser.connect(this.context.destination);
    await new Promise<void>((resolve,reject)=>{
      const timer=window.setTimeout(()=>this.fail('语音连接超时'),20000);
      this.failStart=error=>{clearTimeout(timer);reject(error);};
      this.ws=new WebSocket(url);
      this.ws.onopen=()=>this.send({type:'connect',...config});
      this.ws.onmessage=({data})=>{
        if(this.closed) return;
        const e=JSON.parse(data);
        this.responses.event(e);
        if(this.responses.isCancelRace(e)) return;
        if(e.type==='session.updated' && !this.ready) {
          const ctx=this.context!;
          this.source=ctx.createMediaStreamSource(stream);
          this.capture=new AudioWorkletNode(ctx,'capture');
          this.silence=ctx.createGain(); this.silence.gain.value=0;
          this.capture.port.onmessage=({data})=>{
            if(this.closed) return;
            this.send({type:'input_audio_buffer.append',audio:btoa(String.fromCharCode(...new Uint8Array(data)))});
          };
          this.source.connect(this.analyser!);
          this.source.connect(this.capture).connect(this.silence).connect(ctx.destination);
          this.ready=true;clearTimeout(timer);this.failStart=undefined;resolve();
          if(config.greet===true) for(const event of greetingEvents()) this.send(event);
        } else if(e.type==='input_audio_buffer.speech_started') {this.speaking=true;this.localReply=false;this.clearAudio();}
        else if(e.type==='input_audio_buffer.speech_stopped') {this.speaking=false;this.cue();}
        else if(e.type==='response.created') {this.responseId=e.response?.id;this.suppressed=false;}
        else if(e.type==='response.audio.delta') this.audio(e);
        else if(e.type==='bridge.task_started') {this.cuePending=true;this.cue();}
        else if(e.type==='bridge.task_settled') this.cuePending=false;
        else if(e.type==='error' || e.type==='bridge.error') {this.fail(e.message||e.error?.message||'语音服务错误');return;}
        if(!(this.localReply && e.type === 'response.audio_transcript.done')) this.hooks.event(e);
      };
      this.ws.onerror=()=>this.fail('语音驱动连接失败');
      this.ws.onclose=()=>{if(!this.closed)this.fail('语音连接已结束');};
    });
  }
  private cue() {
    const context=this.context;
    if(!context || !this.cuePending || this.speaking || this.nodes.size) return;
    this.cuePending=false;
    const osc=context.createOscillator(),gain=context.createGain(),now=context.currentTime;
    osc.frequency.setValueAtTime(660,now);osc.frequency.setValueAtTime(880,now+.09);
    gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.08,now+.015);gain.gain.linearRampToValueAtTime(0,now+.18);
    osc.connect(gain).connect(context.destination);osc.onended=()=>{osc.disconnect();gain.disconnect();};osc.start();osc.stop(now+.2);
  }
  private clearAudio() {
    for(const node of this.nodes) {node.onended=null;try{node.stop();}catch{}node.disconnect();}
    this.nodes.clear();this.nextTime=0;this.suppressed=true;
    if(this.responseId)this.blocked.add(this.responseId);
    this.send({type:'bridge.playback',active:false});this.hooks.playback(false);
  }
  interrupt() {this.clearAudio();this.responses.cancel(e=>this.send(e));}
  useLocalReply() {this.localReply=true;this.interrupt();}
  enableCapture(enabled:boolean) {this.stream?.getAudioTracks().forEach(track=>{track.enabled=enabled;});}
  importResult(callId:string,result:unknown) {this.send({type:'bridge.import_result',callId,result});}
  stopTask() {this.cuePending=false;this.send({type:'bridge.stop_task'});}
  text(text:string) {
    if(!this.active) throw Error('请先连接语音会话');
    this.interrupt();
    this.send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});
    this.send({type:'response.create'});
  }
  private audio(e:any) {
    const ctx=this.context;
    if(!ctx || this.localReply || this.suppressed || this.blocked.has(e.response_id))return;
    const bytes=Uint8Array.from(atob(e.delta),c=>c.charCodeAt(0)),pcm=new DataView(bytes.buffer);
    const buffer=ctx.createBuffer(1,bytes.length/2,24000),channel=buffer.getChannelData(0);
    for(let i=0;i<channel.length;i++) channel[i]=pcm.getInt16(i*2,true)/32768;
    this.nextTime=Math.max(ctx.currentTime+.025,this.nextTime);
    if(audioQueueOverflow(this.nextTime,ctx.currentTime,buffer.duration)) {this.interrupt();this.hooks.event({type:'bridge.tool',message:'回复过长，已停止本次播放，通话继续'});return;}
    const node=ctx.createBufferSource();node.buffer=buffer;node.connect(this.playbackAnalyser!);
    if(!this.nodes.size) {this.send({type:'bridge.playback',active:true});this.hooks.playback(true);}
    this.nodes.add(node);node.onended=()=>{this.nodes.delete(node);node.disconnect();if(!this.nodes.size){this.send({type:'bridge.playback',active:false});this.hooks.playback(false);this.cue();}};
    node.start(this.nextTime);this.nextTime+=buffer.duration;
  }
  private fail(message:string) {if(this.closed)return;this.failStart?.(Error(message));this.stop();this.hooks.closed(message);}
  stop() {
    if(this.closed)return;
    this.closed=true;this.ready=false;this.failStart?.(Error('连接已取消'));this.failStart=undefined;
    this.clearAudio();this.ws?.close();this.ws=undefined;
    this.capture?.disconnect();this.source?.disconnect();this.silence?.disconnect();
    this.stream?.getTracks().forEach(t=>t.stop());void this.context?.close();
    this.context=undefined;this.analyser=undefined;this.playbackAnalyser=undefined;
  }
}
