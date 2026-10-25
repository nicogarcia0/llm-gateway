import { readFileSync } from "node:fs";
import { mask, type Config } from "./config.ts";
import type { Provider } from "./pool.ts";
import type { Stats } from "./stats.ts";

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const top = (m: Map<string, { total: number; failed: number }>, n: number) =>
  [...m]
    .map(([name, t]) => ({ name, ...t }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);

/** Everything the dashboard shows. Secrets are masked here, nothing downstream sees them. */
export function buildOverview(config: Config, providers: Provider[], stats: Stats) {
  const lat = stats.latency();
  return {
    server: {
      startedAt: stats.startedAt,
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      node: process.version,
      version,
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
    },
    totals: {
      total: stats.total,
      failed: stats.failed,
      aborted: stats.aborted,
      successRate: stats.total > stats.aborted ? 1 - stats.failed / (stats.total - stats.aborted) : 1,
      latency: lat,
      inflight: providers.reduce((n, p) => n + p.limiter.inflight, 0),
      queued: providers.reduce((n, p) => n + p.limiter.queued, 0),
    },
    series: stats.series(),
    models: top(stats.byModel, 10),
    providers: providers.map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      format: p.format,
      weight: p.weight,
      models: p.models,
      maxConcurrent: p.limiter.max,
      queueSize: p.limiter.maxQueue,
      inflight: p.limiter.inflight,
      queued: p.limiter.queued,
      breakerOpen: p.breakerOpen,
      breakerRemainingSec: p.breakerRemainingSec,
      consecutiveFailures: p.consecutiveFailures,
      served: stats.byProvider.get(p.name)?.total ?? 0,
      keys: p.keyStatus(),
    })),
    clients: config.clientKeys.map((c) => ({
      name: c.name,
      key: mask(c.key),
      ratePerMinute: c.ratePerMinute,
      ...(stats.byClient.get(c.name) ?? { total: 0, failed: 0 }),
    })),
    recent: stats.recent.slice(-200).reverse(),
    config: {
      port: config.port,
      authEnabled: config.clientKeys.length > 0,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      queueTimeoutMs: config.queueTimeoutMs,
      maxAttempts: config.maxAttempts,
      breaker: config.breaker,
      keyCooldownMs: config.keyCooldownMs,
    },
  };
}
