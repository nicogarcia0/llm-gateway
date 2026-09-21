export class QueueFullError extends Error {}
export class QueueTimeoutError extends Error {}

/** Concurrency limiter with a bounded FIFO wait queue. */
export class Semaphore {
  inflight = 0;
  readonly max: number;
  readonly maxQueue: number;
  private waiters: { resolve: () => void; timer?: NodeJS.Timeout }[] = [];

  constructor(max: number, maxQueue: number) {
    this.max = max;
    this.maxQueue = maxQueue;
  }

  get queued() {
    return this.waiters.length;
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.inflight < this.max) {
      this.inflight++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new QueueFullError());

    return new Promise((resolve, reject) => {
      const waiter: { resolve: () => void; timer?: NodeJS.Timeout } = {
        resolve: () => {
          clearTimeout(waiter.timer);
          resolve(this.releaser());
        },
      };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new QueueTimeoutError());
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      // hand the slot straight to the next waiter; inflight stays counted
      if (next) next.resolve();
      else this.inflight--;
    };
  }
}

/** Token bucket: `perMinute` requests per minute with burst up to `perMinute`. */
export class TokenBucket {
  readonly perMinute: number;
  private tokens: number;
  private last = Date.now();

  constructor(perMinute: number) {
    this.perMinute = perMinute;
    this.tokens = perMinute;
  }

  take(): { ok: boolean; retryAfterSec: number } {
    const now = Date.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.ceil(((1 - this.tokens) * 60) / this.perMinute) };
  }
}
