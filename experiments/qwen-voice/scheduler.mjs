// Keep tool completions outside an unfinished user turn and audio playback.
export class ReplyScheduler {
  constructor(send, { delay = 800, schedule = setTimeout, cancel = clearTimeout } = {}) {
    Object.assign(this, { send, delay, schedule, cancel });
    this.results = []; this.responses = new Set(); this.speaking = false;
    this.awaitingUserReply = false; this.playing = false; this.closed = false;
    this.requested = false;
  }
  clearTimer() { if (this.timer !== undefined) this.cancel(this.timer); this.timer = undefined; }
  reconsider() {
    this.clearTimer();
    if (this.closed || !this.results.length || this.speaking || this.awaitingUserReply || this.responses.size || this.playing || this.requested) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (this.closed) return;
      const results = this.results.splice(0);
      for (const item of results) this.send({ type: 'conversation.item.create', item });
      this.requested = true;
      this.send({ type: 'response.create' });
    }, this.delay);
  }
  tool(item) { if (!this.closed) { this.results.push(item); this.reconsider(); } }
  event(e) {
    if (this.closed) return;
    if (e.type === 'input_audio_buffer.speech_started') { this.speaking = true; this.awaitingUserReply = true; }
    if (e.type === 'input_audio_buffer.speech_stopped') this.speaking = false;
    if (e.type === 'response.created') {
      this.responses.add(e.response.id); this.requested = false;
      // Only a response begun after speech stopped can answer that user turn.
      if (!this.speaking) this.awaitingUserReply = false;
    }
    if (e.type === 'response.done') this.responses.delete(e.response.id);
    if (e.type === 'bridge.playback') this.playing = e.active;
    this.reconsider();
  }
  userText() { this.awaitingUserReply = true; this.reconsider(); }
  close() { this.closed = true; this.clearTimer(); this.results.length = 0; }
}
