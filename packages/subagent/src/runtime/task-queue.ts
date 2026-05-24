import { timingStart } from "./timing.js";

/**
 * Lets a queued task voluntarily yield its slot while awaiting work that itself
 * needs queue capacity — e.g. a parent subagent awaiting a child's batch. Without
 * this, a recursive tree deeper than maxRunning deadlocks.
 */
export interface QueueLease {
  suspendDuring<T>(fn: () => Promise<T>): Promise<T>;
}

export class TaskQueue {

  private _pending = new Array<() => void>();
  private _running = 0;

  constructor(public maxRunning: number) { }

  enqueue<T>(task: (lease: QueueLease) => Promise<T>, timingData: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      this._pending.push(() => {
        this._running++;
        let active = true;
        const lease: QueueLease = {
          suspendDuring: async <R>(fn: () => Promise<R>): Promise<R> => {
            if (!active) return fn();
            active = false;
            this._running--;
            this._flush();
            try {
              return await fn();
            } finally {
              await this._acquire();
              active = true;
            }
          },
        };
        const waitMs = Date.now() - queuedAt;
        setImmediate(() => {
          const end = timingStart("queue.task", { ...timingData, waitMs });
          task(lease)
            .then(resolve, reject)
            .finally(() => {
              if (active) this._running--;
              end({ running: this._running, pending: this._pending.length });
              this._flush();
            });
        });
      });
      this._flush();
    });
  }

  private _acquire(): Promise<void> {
    return new Promise(resolve => {
      this._pending.push(() => {
        this._running++;
        resolve();
      });
      this._flush();
    });
  }

  private _flush() {
    while (this._running < this.maxRunning && this._pending.length > 0) {
      this._pending.shift()!();
    }
  }
}
