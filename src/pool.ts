import type { Config, ProviderConfig } from "./config.ts";
import { Semaphore } from "./limits.ts";

type KeyState = { value: string; cooldownUntil: number };

export class Provider {
  readonly name: string;
  readonly baseUrl: string;
  readonly weight: number;
  readonly models: string[];
  readonly limiter: Semaphore;
  private keys: KeyState[];
  private nextKeyIndex = 0;
  private failures = 0;
  private openUntil = 0;
  private breaker: Config["breaker"];

  constructor(cfg: ProviderConfig, breaker: Config["breaker"]) {
    this.breaker = breaker;
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.weight = cfg.weight ?? 1;
    this.models = cfg.models ?? [];
    this.limiter = new Semaphore(cfg.maxConcurrent ?? 8, cfg.queueSize ?? 32);
    this.keys = (cfg.keys ?? []).map((value) => ({ value, cooldownUntil: 0 }));
  }

  get breakerOpen() {
    return Date.now() < this.openUntil;
  }

  get keyCount() {
    return this.keys.length;
  }

  supports(model: string) {
    return this.models.length === 0 || this.models.includes(model);
  }

  get load() {
    return this.limiter.inflight / this.limiter.max / this.weight;
  }

  nextKey(): { value: string | null; cooldown: (ms: number) => void } | undefined {
    if (this.keys.length === 0) return { value: null, cooldown: () => {} };
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.nextKeyIndex + i) % this.keys.length;
      const key = this.keys[idx];
      if (key.cooldownUntil <= now) {
        this.nextKeyIndex = (idx + 1) % this.keys.length;
        return { value: key.value, cooldown: (ms) => (key.cooldownUntil = Date.now() + ms) };
      }
    }
    return undefined;
  }

  recordSuccess() {
    this.failures = 0;
  }

  recordFailure() {
    this.failures++;
    // stays >= threshold after the cooldown, so a failed probe re-opens the breaker immediately
    if (this.failures >= this.breaker.failures) this.openUntil = Date.now() + this.breaker.cooldownMs;
  }
}

export function pickOrder(providers: Provider[], model: string): Provider[] {
  return providers
    .filter((p) => p.supports(model) && !p.breakerOpen)
    .map((p) => ({ p, score: p.load + Math.random() * 1e-6 }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.p);
}
