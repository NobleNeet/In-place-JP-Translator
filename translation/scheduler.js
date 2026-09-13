// translation/scheduler.js
// Bounded concurrency limiter (semaphore).
// Guarantees the number of in-flight requests never exceeds `concurrency`.

export class Semaphore {
  constructor(concurrency = 2) {
    this.concurrency = Math.max(1, concurrency | 0);
    this.active = 0;
    this.waiters = [];
  }

  update(concurrency) {
    this.concurrency = Math.max(1, concurrency | 0);
    this._pump();
  }

  acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this._pump();
  }

  get pending() {
    return this.waiters.length;
  }

  _pump() {
    while (this.active < this.concurrency && this.waiters.length > 0) {
      this.active += 1;
      const resolve = this.waiters.shift();
      resolve();
    }
  }
}
