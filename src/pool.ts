import { mask, type Config, type ProviderConfig } from "./config.ts";
import { Semaphore } from "./limits.ts";
import { resolveAdapter, validateAdapter, type AdapterConfig } from "./adapters.ts";

type KeyState = { value: string; cooldownUntil: number; uses: number };

export class Provider {
  readonly name: string;
  readonly baseUrl: string;
  readonly weight: number;
  readonly models: string[];
  readonly limiter: Semaphore;
  /** null = the provider speaks OpenAI and requests pass through untouched. */
  readonly adapter: AdapterConfig | null;
  readonly format: string;
  /** Same config + breaker settings => same signature, so a config reload can keep this instance and its live state. */
  readonly signature: string;
  private keys: KeyState[];
  private nextKeyIndex = 0;
  private failures = 0;
  private openUntil = 0;
  private breaker: Config["breaker"];

  constructor(cfg: ProviderConfig, breaker: Config["breaker"]) {
    this.breaker = breaker;
    this.signature = Provider.signature(cfg, breaker);
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.format = cfg.format ?? "openai";
    this.adapter = resolveAdapter(cfg.format, cfg.adapter);
    const problems = validateAdapter(this.adapter);
    if (problems.length) throw new Error(`Provider ${cfg.name}: adapter.${problems[0].path}: ${problems[0].message}`);
    this.weight = cfg.weight ?? 1;
    this.models = cfg.models ?? [];
    this.limiter = new Semaphore(cfg.maxConcurrent ?? 8, cfg.queueSize ?? 32);
    this.keys = (cfg.keys ?? []).map((value) => ({ value, cooldownUntil: 0, uses: 0 }));
  }

  static signature(cfg: ProviderConfig, breaker: Config["breaker"]) {
    return JSON.stringify([cfg, breaker]);
  }

  /** Close the breaker and clear every key cooldown (admin action). */
  reset() {
    this.failures = 0;
    this.openUntil = 0;
    for (const k of this.keys) k.cooldownUntil = 0;
  }

  get breakerOpen() {
    return Date.now() < this.openUntil;
  }

  get keyCount() {
    return this.keys.length;
  }

  get consecutiveFailures() {
    return this.failures;
  }

  get breakerRemainingSec() {
    return Math.max(0, Math.ceil((this.openUntil - Date.now()) / 1000));
  }

  /** Masked view of the pool for the admin dashboard; never exposes full keys. */
  keyStatus() {
    const now = Date.now();
    return this.keys.map((k) => ({
      key: mask(k.value),
      uses: k.uses,
      cooldownSec: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
    }));
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
        key.uses++;
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

/** `translatable`: false for requests an adapter cannot carry (tools, images, other endpoints), which only OpenAI-format providers get. */
export function pickOrder(providers: Provider[], model: string, translatable = true): Provider[] {
  return providers
    .filter((p) => p.supports(model) && !p.breakerOpen && (translatable || !p.adapter))
    .map((p) => ({ p, score: p.load + Math.random() * 1e-6 }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.p);
}
