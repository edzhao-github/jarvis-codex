// Generation can finish before local audio playback finishes.
export class ResponseControl {
  active = undefined;
  pendingCancels = 0;
  event(e) {
    if (e.type === 'response.created') this.active = e.response?.id;
    if (e.type === 'response.done' && e.response?.id === this.active) this.active = undefined;
  }
  cancel(send) {
    if (!this.active) return false;
    this.active = undefined;
    this.pendingCancels++;
    send({type:'response.cancel'});
    return true;
  }
  isCancelRace(e) {
    if (!this.pendingCancels || e.type !== 'error' || !/conversation has no active response\.?$/i.test(e.error?.message || e.message || '')) return false;
    this.pendingCancels--;
    return true;
  }
}
// Bound retained PCM memory, allowing normal responses generated faster than speech.
export const MAX_QUEUED_AUDIO_SECONDS = 120;
export function audioQueueOverflow(nextTime, now, duration) {
  return Math.max(0, nextTime - now) + duration > MAX_QUEUED_AUDIO_SECONDS;
}
