export class TaskQueue {

  private _pending = new Array<() => void>();
  private _running = 0;

  constructor(readonly maxRunning: number) { }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._pending.push(() => {
        this._running++;
        setImmediate(() => {
          task()
            .then(resolve, reject)
            .finally(() => {
              this._running--;
              this._flush();
            });
        });
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
