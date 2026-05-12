import { timingMark, timingStart } from "./timing.js";

export class TaskQueue {

  private _pending = new Array<() => void>();
  private _running = 0;

  constructor(public maxRunning: number) { }

  enqueue<T>(task: () => Promise<T>, timingData: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      timingMark("queue.enqueue", { ...timingData, pending: this._pending.length, running: this._running, maxRunning: this.maxRunning });
      this._pending.push(() => {
        this._running++;
        const waitMs = Date.now() - queuedAt;
        timingMark("queue.dispatch", { ...timingData, waitMs, pending: this._pending.length, running: this._running, maxRunning: this.maxRunning });
        setImmediate(() => {
          const end = timingStart("queue.task", { ...timingData, waitMs });
          task()
            .then(resolve, reject)
            .finally(() => {
              this._running--;
              end({ running: this._running, pending: this._pending.length });
              this._flush();
            });
        });
      });
      this._flush();
    });
  }

  private _flush() {
    timingMark("queue.flush", { pending: this._pending.length, running: this._running, maxRunning: this.maxRunning });
    while (this._running < this.maxRunning && this._pending.length > 0) {
      this._pending.shift()!();
    }
  }
}
