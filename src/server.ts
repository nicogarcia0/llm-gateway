import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { resolveSecret, withDefaults, type Config } from "./config.ts";
import { ConfigError, describe, merge, probeChat, type Store } from "./configAdmin.ts";
import { QueueFullError, TokenBucket } from "./limits.ts";
import { Metrics } from "./metrics.ts";
import { Provider, pickOrder } from "./pool.ts";
import { buildUpstream, completionAsSse, errorMessage, isTextChat, toOpenAI, translateStream } from "./adapters.ts";
import { Stats } from "./stats.ts";
import { buildOverview } from "./admin.ts";

const MAX_BODY_BYTES = 1_000_000;

type Client = { name: string; hash: Buffer | null; bucket: TokenBucket | null };

/** Per-request facts filled in as the request moves through the gateway; recorded when it closes. */
type Ctx = { id: string; client: string; model: string; provider: string | null; attempts: number; error?: string };

const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:";

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

/**
 * `store` makes the config editable from the admin API. Edits are validated, written to the config file
 * and applied to the running gateway without a restart. `config` is updated in place.
 */
export function createGateway(config: Config, opts: { log?: boolean; store?: Store; env?: NodeJS.ProcessEnv } = {}) {
  const log = opts.log ?? true;
  const store = opts.store;
  const env = opts.env ?? process.env;
  const providers = config.providers.map((p) => new Provider(p, config.breaker));
  const metrics = new Metrics();
  const stats = new Stats();
  const adminHash = config.adminKey ? sha256(config.adminKey) : null;
  const adminFailures = new TokenBucket(10); // wrong-key attempts per minute, all sources
  let adminLockedUntil = 0; // ponytail: global lockout, per-IP if the gateway sits behind a proxy that forwards it
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

  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx, url: URL) {
    const id = ctx.id;
    const raw = await readBody(req, MAX_BODY_BYTES).catch(() => null);
    if (!raw) return sendError(res, 413, "invalid_request_error", "Request body too large or unreadable");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendError(res, 400, "invalid_request_error", "Body must be valid JSON");
    }
    const model = parsed?.model;
    if (typeof model !== "string") return sendError(res, 400, "invalid_request_error", "Field 'model' is required");
    const wantStream = parsed.stream === true;

    // adapters translate plain text chat only; tools, images and other endpoints stay with OpenAI-format providers
    const translatable = url.pathname === "/v1/chat/completions" && isTextChat(parsed);
    const candidates = pickOrder(providers, model, translatable);
    if (candidates.length === 0) {
      ctx.model = "(unrouted)";
      metrics.inc("gateway_rejected_total", { reason: "no_provider" });
      const onlyAdapters = !translatable && providers.some((p) => p.adapter && p.supports(model) && !p.breakerOpen);
      return sendError(res, 503, "service_unavailable", onlyAdapters
        ? `Model '${model}' is only served by providers with a translated API, which handle plain text chat only (no tools, images or other endpoints)`
        : `No provider available for model '${model}'`, {
        "retry-after": "5",
      });
    }

    ctx.model = model;
    const clientGone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientGone.abort();
    });

    const path = url.pathname.replace(/^\/v1/, "") + url.search;
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

      // the client may have left while we waited in the queue; don't spend upstream quota on nobody
      if (clientGone.signal.aborted) {
        release();
        return;
      }

      let handedOff = false;
      try {
        for (let k = 0; k < Math.max(1, provider.keyCount); k++) {
          if (ctx.attempts >= config.maxAttempts) break outer;
          const key = provider.nextKey();
          if (!key) break;
          ctx.attempts++;

          const attempt = new AbortController();
          const timer = setTimeout(() => attempt.abort(), config.upstreamTimeoutMs);
          clientGone.signal.addEventListener("abort", () => attempt.abort(), { once: true });

          const ad = provider.adapter;
          const translated = ad ? buildUpstream(ad, parsed, provider.baseUrl, key.value, wantStream) : null;
          let upstream: Response;
          try {
            upstream = await fetch(translated ? translated.url : `${provider.baseUrl}${path}`, {
              method: "POST",
              headers: translated
                ? translated.headers
                : {
                    "content-type": "application/json",
                    accept: req.headers.accept ?? "application/json",
                    ...(key.value ? { authorization: `Bearer ${key.value}` } : {}),
                  },
              body: translated ? translated.body : new Uint8Array(raw),
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

          const headers: Record<string, string> = {
            "x-gateway-provider": provider.name,
            "x-request-id": id,
          };

          if (ad && translated) {
            // the provider speaks another API: answer the client in OpenAI format
            if (status >= 400) {
              const text = await upstream.text().catch(() => "");
              provider.recordSuccess();
              ctx.provider = provider.name;
              return sendError(res, status, "upstream_error", `${provider.name}: ${errorMessage(ad, text, status)}`, headers);
            }
            const sseHeaders = { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" };
            if (translated.streaming && upstream.body) {
              provider.recordSuccess();
              ctx.provider = provider.name;
              res.writeHead(200, sseHeaders);
              handedOff = true;
              res.on("close", release);
              Readable.fromWeb(upstream.body.pipeThrough(translateStream(ad, model)) as never)
                .on("error", () => res.destroy())
                .pipe(res);
              return;
            }
            const bodyTimer = setTimeout(() => attempt.abort(), config.upstreamTimeoutMs);
            const completion = await upstream.json().then((j) => toOpenAI(ad, j, model), () => null).finally(() => clearTimeout(bodyTimer));
            if (clientGone.signal.aborted) return;
            if (!completion) {
              provider.recordFailure();
              sawUpstreamFailure = true;
              lastError = `${provider.name}: could not read a reply from the provider's answer (check the response mapping)`;
              metrics.inc("gateway_retries_total", { provider: provider.name, reason: "bad_response" });
              break;
            }
            provider.recordSuccess();
            ctx.provider = provider.name;
            if (wantStream) {
              res.writeHead(200, sseHeaders);
              res.end(completionAsSse(completion));
            } else {
              res.writeHead(200, { ...headers, "content-type": "application/json" });
              res.end(JSON.stringify(completion));
            }
            return;
          }

          provider.recordSuccess();
          const ct = upstream.headers.get("content-type");
          if (ct) headers["content-type"] = ct;
          res.writeHead(status, headers);

          handedOff = true;
          ctx.provider = provider.name;
          if (!upstream.body) {
            res.end();
            release();
          } else {
            res.on("close", release);
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
      ctx.error = lastError;
      return sendError(res, 503, "service_unavailable", "All providers are at capacity", { "retry-after": "2" });
    }
    ctx.error = lastError;
    metrics.inc("gateway_rejected_total", { reason: "all_failed" });
    return sendError(res, 502, "bad_gateway", `All providers failed (last: ${lastError})`);
  }

  /** Swap in a new config. Providers whose settings did not change keep their live state (breaker, cooldowns, queue). */
  function apply(next: Config) {
    const oldProviders = new Map(providers.map((p) => [p.name, p]));
    // ponytail: a changed provider is rebuilt, so requests already in flight keep the old limiter until they finish
    providers.splice(0, providers.length, ...next.providers.map((pc) => {
      const old = oldProviders.get(pc.name);
      return old?.signature === Provider.signature(pc, next.breaker) ? old : new Provider(pc, next.breaker);
    }));
    const oldClients = new Map(clients.map((c) => [c.name, c]));
    clients.splice(0, clients.length, ...next.clientKeys.map((c): Client => {
      const rate = c.ratePerMinute ?? 60;
      const bucket = oldClients.get(c.name)?.bucket;
      return { name: c.name, hash: sha256(c.key), bucket: bucket?.perMinute === rate ? bucket : new TokenBucket(rate) };
    }));
    Object.assign(config, { ...next, port: config.port }); // the port cannot change while listening
  }

  async function admin(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (req.method !== "GET") return sendError(res, 405, "invalid_request_error", "Method not allowed");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": ADMIN_CSP, "cache-control": "no-store" });
      return void res.end(readFileSync(new URL("./admin.html", import.meta.url)));
    }
    if (!url.pathname.startsWith("/admin/api/")) return sendError(res, 404, "not_found", "Not found");

    const locked = () => sendError(res, 429, "rate_limit_error", "Too many failed attempts", { "retry-after": "60" });
    if (Date.now() < adminLockedUntil) return locked();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m || !timingSafeEqual(adminHash!, sha256(m[1]))) {
      if (adminFailures.take().ok) return sendError(res, 401, "authentication_error", "Invalid admin key");
      adminLockedUntil = Date.now() + 60_000;
      return locked();
    }

    const noStore = { "cache-control": "no-store" };
    const route = `${req.method} ${url.pathname}`;
    const body = async (): Promise<unknown> => readBody(req, 256_000).then((b) => JSON.parse(b.toString("utf8")), () => undefined);

    if (route === "GET /admin/api/overview") return sendJson(res, 200, { ...buildOverview(config, providers, stats), editable: !!store }, noStore);
    if (route === "POST /admin/api/stats/reset") {
      stats.reset();
      return sendJson(res, 200, { ok: true });
    }
    const reset = /^POST \/admin\/api\/providers\/([^/]+)\/reset$/.exec(route);
    if (reset) {
      const p = providers.find((x) => x.name === decodeURIComponent(reset[1]));
      if (!p) return sendError(res, 404, "not_found", "Unknown provider");
      p.reset();
      return sendJson(res, 200, { ok: true });
    }

    if (route === "POST /admin/api/test") {
      // Probe GET {baseUrl}/models, either for a configured provider or for values typed in the form.
      const b = (await body()) as { provider?: unknown; baseUrl?: unknown; key?: unknown } | undefined;
      let base = typeof b?.baseUrl === "string" ? b.baseUrl.trim().replace(/\/$/, "") : "";
      let key: string | null = typeof b?.key === "string" && b.key.trim() ? b.key.trim() : null;
      const known = typeof b?.provider === "string" ? providers.find((p) => p.name === b.provider) : undefined;
      if (known) {
        base = known.baseUrl;
        key = known.nextKey()?.value ?? null;
      } else if (key) {
        try {
          key = resolveSecret(key, env);
        } catch (e) {
          return sendJson(res, 200, { ok: false, status: 0, ms: 0, error: e instanceof Error ? e.message : String(e), models: [] });
        }
      }
      if (!/^https?:\/\//.test(base)) return sendJson(res, 200, { ok: false, status: 0, ms: 0, error: "Enter a valid http(s) base URL first", models: [] });
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8_000) });
        const json = (await r.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
        const models = Array.isArray(json?.data) ? json.data.map((x) => x?.id).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
        return sendJson(res, 200, { ok: r.ok, status: r.status, ms: Date.now() - t0, models });
      } catch (e) {
        return sendJson(res, 200, { ok: false, status: 0, ms: Date.now() - t0, error: e instanceof Error && e.name === "TimeoutError" ? "Timed out after 8s" : "Could not connect", models: [] });
      }
    }

    if (route === "POST /admin/api/test-chat") {
      const b = await body();
      if (!b || typeof b !== "object") return sendError(res, 400, "invalid_request_error", "Body must be a JSON object");
      return sendJson(res, 200, await probeChat(b as Record<string, unknown>, store, env));
    }

    if (url.pathname === "/admin/api/config" && (req.method === "GET" || req.method === "PUT")) {
      if (!store) return sendError(res, 501, "not_implemented", "This gateway was started without a config file, so settings are read-only");
      if (req.method === "GET") return sendJson(res, 200, describe(store.raw, config, env), noStore);
      try {
        const merged = merge(store.raw, await body(), env);
        try {
          store.save(merged.raw);
        } catch (e) {
          return sendError(res, 500, "server_error", `Could not write the config file: ${e instanceof Error ? e.message : e}`);
        }
        apply(merged.config);
        if (log) console.log(JSON.stringify({ ts: new Date().toISOString(), event: "config_updated", providers: providers.length, clients: clients.length }));
        return sendJson(res, 200, { config: describe(store.raw, config, env), generated: merged.generated }, noStore);
      } catch (e) {
        if (e instanceof ConfigError) return sendJson(res, 422, { error: { type: "invalid_config", message: e.message, issues: e.issues } });
        throw e;
      }
    }
    return sendError(res, 404, "not_found", "Not found");
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

    if (adminHash && url.pathname.startsWith("/admin")) return admin(req, res, url);

    if (!url.pathname.startsWith("/v1/")) return sendError(res, 404, "not_found", "Not found");

    const ctx: Ctx = { id: randomUUID(), client: "(unauthenticated)", model: "-", provider: null, attempts: 0 };
    if (req.method === "POST") {
      const started = Date.now();
      res.on("close", () => {
        const rec = {
          ts: started,
          id: ctx.id,
          client: ctx.client,
          model: ctx.model,
          provider: ctx.provider,
          status: res.writableEnded ? res.statusCode : 499,
          ms: Date.now() - started,
          attempts: ctx.attempts,
          error: ctx.error,
        };
        stats.record(rec);
        if (log) console.log(JSON.stringify({ ...rec, ts: new Date(started).toISOString() }));
      });
    }

    const client = authenticate(req);
    if (!client) return sendError(res, 401, "authentication_error", "Missing or invalid API key");
    ctx.client = client.name;

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

    if (req.method === "POST") return proxy(req, res, ctx, url);
    return sendError(res, 405, "invalid_request_error", "Method not allowed");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (log) console.error("unhandled error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) sendError(res, 500, "server_error", "Internal error");
      else res.destroy();
    });
  });

  return { server, providers, metrics, stats };
}
