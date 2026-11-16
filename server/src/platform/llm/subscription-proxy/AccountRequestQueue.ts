import { SubscriptionError } from "./SubscriptionError";

interface Waiter {
  start: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

export class AccountRequestQueue {
  private active = false;
  private readonly waiters: Waiter[] = [];
  private cooldownUntil = 0;
  constructor(private readonly now: () => number = Date.now) {}

  coolDown(retryAfter: string | null): void {
    if (!retryAfter) return;
    const seconds = Number(retryAfter);
    const until = Number.isFinite(seconds) && seconds >= 0
      ? this.now() + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(until) && until > this.now()) this.cooldownUntil = Math.max(this.cooldownUntil, until);
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal, reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
        start: () => {
          signal.removeEventListener("abort", waiter.abort);
          this.active = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active = false;
            this.process();
          });
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.process();
    });
  }

  private process(): void {
    if (this.active) return;
    while (this.waiters.length) {
      const next = this.waiters.shift()!;
      if (next.signal.aborted) { next.abort(); continue; }
      if (this.cooldownUntil > this.now()) {
        next.signal.removeEventListener("abort", next.abort);
        next.reject(new SubscriptionError("COPILOT_RATE_LIMITED", "Copilot 账户正在等待请求限额恢复，请稍后重试。", 429));
        continue;
      }
      next.start();
      return;
    }
  }
}
