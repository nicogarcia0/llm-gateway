export type RequestRecord = {
  ts: number;
  id: string;
  client: string;
  model: string;
  provider: string | null;
  status: number;
  ms: number;
  attempts: number;
  error?: string;
};

type Tally = { total: number; failed: number };

const RECENT_MAX = 500;
const MAX_MODELS = 200; // models: [] means "any", so clients control the label; cap the map
const WINDOW_MIN = 60;

// 499 = client went away (or the stream broke after it started); not counted as a gateway failure
export const isFailure = (status: number) => status >= 400 && status !== 499;

function bump(map: Map<string, Tally>, key: string, failed: boolean) {
  const t = map.get(key) ?? { total: 0, failed: 0 };
  t.total++;
  if (failed) t.failed++;
  map.set(key, t);
}

export class Stats {
  readonly startedAt = Date.now();
  total = 0;
  failed = 0;
  aborted = 0;
  readonly byModel = new Map<string, Tally>();
  readonly byClient = new Map<string, Tally>();
  readonly byProvider = new Map<string, Tally>();
  readonly recent: RequestRecord[] = [];
  private minutes = new Map<number, { ok: number; failed: number }>();

  record(r: RequestRecord) {
    const failed = isFailure(r.status);
    this.total++;
    if (failed) this.failed++;
    if (r.status === 499) this.aborted++;

    const model = this.byModel.has(r.model) || this.byModel.size < MAX_MODELS ? r.model : "(other)";
    bump(this.byModel, model, failed);
    bump(this.byClient, r.client, failed);
    if (r.provider) bump(this.byProvider, r.provider, failed);

    this.recent.push(r);
    if (this.recent.length > RECENT_MAX) this.recent.shift();

    const minute = Math.floor(r.ts / 60_000);
    const slot = this.minutes.get(minute) ?? { ok: 0, failed: 0 };
    if (failed) slot.failed++;
    else slot.ok++;
    this.minutes.set(minute, slot);
    for (const k of this.minutes.keys()) if (k <= minute - WINDOW_MIN) this.minutes.delete(k);
  }

  /** Clears counters, breakdowns and history; `startedAt` stays so uptime keeps counting. */
  reset() {
    this.total = this.failed = this.aborted = 0;
    this.byModel.clear();
    this.byClient.clear();
    this.byProvider.clear();
    this.recent.length = 0;
    this.minutes.clear();
  }

  /** Last 60 minutes, oldest first, empty minutes included. */
  series() {
    const now = Math.floor(Date.now() / 60_000);
    return Array.from({ length: WINDOW_MIN }, (_, i) => {
      const minute = now - WINDOW_MIN + 1 + i;
      return { t: minute * 60_000, ...(this.minutes.get(minute) ?? { ok: 0, failed: 0 }) };
    });
  }

  /** Latency of successful requests among the last RECENT_MAX. */
  latency() {
    const ms = this.recent.filter((r) => r.status < 400).map((r) => r.ms).sort((a, b) => a - b);
    if (ms.length === 0) return { avg: 0, p50: 0, p95: 0 };
    const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
    return { avg: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), p50: q(0.5), p95: q(0.95) };
  }
}
