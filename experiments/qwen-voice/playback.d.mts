export class ResponseControl {
 active: string | undefined;
 event(e: any): void;
 cancel(send: (e: any) => void): boolean;
 isCancelRace(e: any): boolean;
}
export function audioQueueOverflow(nextTime: number, now: number, duration: number): boolean;
