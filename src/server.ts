import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { Config } from "./config.ts";
import { QueueFullError, TokenBucket } from "./limits.ts";
import { Metrics } from "./metrics.ts";
import { Provider, pickOrder } from "./pool.ts";

const MAX_BODY_BYTES = 1_000_000;

type Client = { name: string; hash: Buffer | null; bucket: TokenBucket | null };

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
) {
  sendJson(res, status, { error: { message, type } }, headers);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= limit) return void chunks.push(c);
      // Keep draining so the client can read our 413 instead of hitting a reset.
      if (!tooLarge) {
        tooLarge = true;
        reject(new Error("body_too_large"));
      }
      if (size > limit * 20) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function retryAfterMs(res: Response): number | undefined {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, 10 * 60_000) : undefined;
}

export function createGateway(config: Config, opts: { log?: boolean } = {}) {
  const log = opts.log ?? true;
  const providers = config.providers.map((p) => new Provider(p, config.breaker));
  const metrics = new Metrics();
  const clients: Client[] = config.clientKeys.map((c) => ({
    name: c.name,
    hash: sha256(c.key),
    bucket: new TokenBucket(c.ratePerMinute ?? 60),
  }));
  const anonymous: Client = { name: "anonymous", hash: null, bucket: null };

  function authenticate(req: http.IncomingMessage): Client | null {
    if (clients.length === 0) return anonymous;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const given = sha256(m[1]);
    return clients.find((c) => c.hash && timingSafeEqual(c.hash, given)) ?? null;
  }

  function gauges() {
    const g: Record<string, number> = {};
    for (const p of providers) {
      g[`gateway_provider_inflight{provider="${p.name}"}`] = p.limiter.inflight;
      g[`gateway_provider_queued{provider="${p.name}"}`] = p.limiter.queued;
      g[`gateway_provider_breaker_open{provider="${p.name}"}`] = p.breakerOpen ? 1 : 0;
    }
    return g;
  }

  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, client: Client, url: URL) {
    const id = randomUUID();
    const started = Date.now();
    const raw = await readBody(req, MAX_BODY_BYTES).catch(() => null);
    if (!raw) return sendError(res, 413, "invalid_request_error", "Request body too large or unreadable");

    let model: unknown;
    try {
      model = JSON.parse(raw.toString("utf8"))?.model;
    } catch {
      return sendError(res, 400, "invalid_request_error", "Body must be valid JSON");
    }
    if (typeof model !== "string") return sendError(res, 400, "invalid_request_error", "Field 'model' is required");

    const candidates = pickOrder(providers, model);
    if (candidates.length === 0) {
      metrics.inc("gateway_rejected_total", { reason: "no_provider" });
      return sendError(res, 503, "service_unavailable", `No provider available for model '${model}'`, {
        "retry-after": "5",
      });
    }

    const clientGone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientGone.abort();
    });

    const path = url.pathname.replace(/^\/v1/, "") + url.search;
    let attempts = 0;
    let lastError = "no attempt made";
    let sawUpstreamFailure = false;
    let sawCapacityReject = false;

    outer: for (const provider of candidates) {
      let release: () => void;
      try {
        release = await provider.limiter.acquire(config.queueTimeoutMs);
      } catch (err) {
        sawCapacityReject = true;
        const reason = err instanceof QueueFullError ? "queue_full" : "queue_timeout";
        metrics.inc("gateway_rejected_total", { provider: provider.name, reason });
        lastError = `${provider.name}: ${reason}`;
        continue;
      }

      let handedOff = false;
      try {
        for (let k = 0; k < Math.max(1, provider.keyCount); k++) {
          if (attempts >= config.maxAttempts) break outer;
          const key = provider.nextKey();
          if (!key) break;
          attempts++;

          const attempt = new AbortController();
          const timer = setTimeout(() => attempt.abort(), config.upstreamTimeoutMs);
          clientGone.signal.addEventListener("abort", () => attempt.abort(), { once: true });

          let upstream: Response;
          try {
            upstream = await fetch(`${provider.baseUrl}${path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: req.headers.accept ?? "application/json",
                ...(key.value ? { authorization: `Bearer ${key.value}` } : {}),
              },
              body: new Uint8Array(raw),
              signal: attempt.signal,
            });
          } catch {
            clearTimeout(timer);
            if (clientGone.signal.aborted) return;
            provider.recordFailure();
            sawUpstreamFailure = true;
            lastError = `${provider.name}: unreachable or timed out`;
            metrics.inc("gateway_retries_total", { provider: provider.name, reason: "network" });
            break;
          }
          clearTimeout(timer); // header timeout only; streaming bodies may run longer

          const status = upstream.status;
          metrics.inc("gateway_upstream_requests_total", { provider: provider.name, status });

          if (status === 429 || status === 401 || status === 403) {
            key.cooldown(status === 429 ? (retryAfterMs(upstream) ?? config.keyCooldownMs) : 5 * 60_000);
            void upstream.body?.cancel();
            sawUpstreamFailure = true;
            lastError = `${provider.name}: upstream ${status}`;
            metrics.inc("gateway_retries_total", { provider: provider.name, reason: String(status) });
            continue;
          }

          if (status >= 500) {
            provider.recordFailure();
            void upstream.body?.cancel();
            sawUpstreamFailure = true;
            lastError = `${provider.name}: upstream ${status}`;
            metrics.inc("gateway_retries_total", { provider: provider.name, reason: String(status) });
            break;
          }

          provider.recordSuccess();
          const headers: Record<string, string> = {
            "x-gateway-provider": provider.name,
            "x-request-id": id,
          };
          const ct = upstream.headers.get("content-type");
          if (ct) headers["content-type"] = ct;
          res.writeHead(status, headers);

          handedOff = true;
          const done = () => {
            release();
            if (log) {
              console.log(
                JSON.stringify({ ts: new Date().toISOString(), id, client: client.name, model, provider: provider.name, status, ms: Date.now() - started }),
              );
            }
          };
          if (!upstream.body) {
            res.end();
            done();
          } else {
            res.on("close", done);
            Readable.fromWeb(upstream.body as never)
              .on("error", () => res.destroy())
              .pipe(res);
          }
          return;
        }
      } finally {
        if (!handedOff) release();
      }
    }

    if (!sawUpstreamFailure && sawCapacityReject) {
      return sendError(res, 503, "service_unavailable", "All providers are at capacity", { "retry-after": "2" });
    }
    metrics.inc("gateway_rejected_total", { reason: "all_failed" });
    return sendError(res, 502, "bad_gateway", `All providers failed (last: ${lastError})`);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://gateway");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        providers: providers.map((p) => ({
          name: p.name,
          breakerOpen: p.breakerOpen,
          inflight: p.limiter.inflight,
          queued: p.limiter.queued,
        })),
      });
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return void res.end(metrics.render(gauges()));
    }

    if (!url.pathname.startsWith("/v1/")) return sendError(res, 404, "not_found", "Not found");

    const client = authenticate(req);
    if (!client) return sendError(res, 401, "authentication_error", "Missing or invalid API key");

    if (client.bucket) {
      const limit = client.bucket.take();
      if (!limit.ok) {
        metrics.inc("gateway_rejected_total", { reason: "rate_limited" });
        return sendError(res, 429, "rate_limit_error", "Rate limit exceeded", {
          "retry-after": String(limit.retryAfterSec),
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const seen = new Map<string, string>();
      for (const p of providers) for (const m of p.models) if (!seen.has(m)) seen.set(m, p.name);
      return sendJson(res, 200, {
        object: "list",
        data: [...seen].map(([id, owner]) => ({ id, object: "model", owned_by: owner })),
      });
    }

    if (req.method === "POST") return proxy(req, res, client, url);
    return sendError(res, 405, "invalid_request_error", "Method not allowed");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (log) console.error("unhandled error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) sendError(res, 500, "server_error", "Internal error");
      else res.destroy();
    });
  });

  return { server, providers, metrics };
}
