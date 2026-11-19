class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Keep fractional source position across render blocks.
    const step = sampleRate / 16000;
    for (; this.position < input.length; this.position += step) {
      this.samples.push(Math.max(-1, Math.min(1, input[Math.floor(this.position)])));
      if (this.samples.length === 320) {
        const pcm = Int16Array.from(this.samples, x => Math.round(x * (x < 0 ? 32768 : 32767)));
        this.port.postMessage(pcm.buffer, [pcm.buffer]); this.samples = [];
      }
    }
    this.position -= input.length;
    return true;
  }
}
registerProcessor('capture', Capture);
