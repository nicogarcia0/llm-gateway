/**
 * The "backend" of the public demo. It runs in the browser and answers the dashboard's /admin/api calls.
 *
 * It is not a re-implementation: it runs the gateway's own code (Provider, Stats, buildOverview, the config
 * validation and the API adapters) and only replaces the outside world, i.e. the traffic and the AI providers,
 * with simulated ones. That keeps the demo faithful to the real dashboard and stops it drifting from it.
 */
import { withDefaults, type Config, type ConfigInput } from "../src/config.ts";
import { ConfigError, describe, merge, probeChat } from "../src/configAdmin.ts";
import { buildOverview } from "../src/admin.ts";
import { Provider, pickOrder } from "../src/pool.ts";
import { Stats } from "../src/stats.ts";

const INITIAL: ConfigInput = {
  port: 8080,
  adminKey: "env:GATEWAY_ADMIN_KEY",
  clientKeys: [
    { name: "web-app", key: "gw_demo_web_4f9c2a7e1b8d3c6a", ratePerMinute: 600 },
    { name: "mobile-app", key: "gw_demo_mob_91d2e7a05c3b8f4e", ratePerMinute: 300 },
    { name: "batch-jobs", key: "gw_demo_bat_c07a5e92d1f48b36", ratePerMinute: 120 },
    { name: "internal-tools", key: "gw_demo_int_2b8e6f10a9d47c53", ratePerMinute: 60 },
  ],
  providers: [
    { name: "openai", baseUrl: "https://api.openai.com/v1", keys: ["env:OPENAI_API_KEY", "sk-proj-demo-7f3a91b2", "sk-proj-demo-e5c4kC3d"], weight: 3, maxConcurrent: 8, queueSize: 32, models: ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"] },
    { name: "claude", baseUrl: "https://api.anthropic.com/v1", format: "anthropic", keys: ["env:ANTHROPIC_API_KEY"], weight: 2, maxConcurrent: 6, queueSize: 16, models: ["claude-sonnet-4-5", "claude-haiku-4-5"] },
    { name: "groq", baseUrl: "https://api.groq.com/openai/v1", keys: ["env:GROQ_API_KEY"], weight: 2, maxConcurrent: 6, queueSize: 16, models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
    { name: "local-ollama", baseUrl: "http://localhost:11434/v1", weight: 1, maxConcurrent: 2, queueSize: 8, models: ["llama-3.1-8b-instant", "llama3.2", "qwen2.5-coder"] },
  ],
};

// Any env:NAME reference "resolves", so people can try them without anything being set.
const env = new Proxy({} as NodeJS.ProcessEnv, { get: (_t, k) => (typeof k === "string" ? "demo-env-value-0000" : undefined) });

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const POPULARITY = (model: string) => (/embedding/.test(model) ? 1 : /mini|8b|haiku|llama3\.2/.test(model) ? 3 : /coder/.test(model) ? 1.2 : 2);
const LATENCY: Record<string, [number, number]> = { openai: [350, 1500], claude: [500, 1800], groq: [90, 480], "local-ollama": [700, 2600] };
const CLIENT_WEIGHTS = [50, 25, 15, 10];

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });

export function createDemo(opts: { live?: boolean; seed?: number } = {}) {
  const live = opts.live ?? false;
  const rand = mulberry32(opts.seed ?? 7);
  const between = (a: number, b: number) => a + rand() * (b - a);
  const weighted = <T,>(items: T[], w: (x: T) => number): T => {
    let r = rand() * items.reduce((s, x) => s + w(x), 0);
    for (const x of items) if ((r -= w(x)) <= 0) return x;
    return items[items.length - 1];
  };

  let raw: ConfigInput = structuredClone(INITIAL);
  let config: Config = withDefaults(raw, env);
  const providers = config.providers.map((p) => new Provider(p, config.breaker));
  const stats = new Stats();

  /** Same hot swap the real gateway does when settings are saved. */
  function apply(next: Config) {
    const old = new Map(providers.map((p) => [p.name, p]));
    providers.splice(0, providers.length, ...next.providers.map((pc) => {
      const o = old.get(pc.name);
      return o?.signature === Provider.signature(pc, next.breaker) ? o : new Provider(pc, next.breaker);
    }));
    config = next;
  }

  /** One simulated request. `held` keeps a provider slot busy for its latency, so load, queue and in-flight move. */
  function simulate(ts: number, held: boolean) {
    const names = config.clientKeys.map((c) => c.name);
    const client = names.length ? weighted(names, (n) => CLIENT_WEIGHTS[names.indexOf(n)] ?? 5) : "anonymous";
    const rec = (provider: string | null, status: number, ms: number, attempts: number, error?: string, model = "(unrouted)") =>
      stats.record({ ts, id: crypto.randomUUID(), client, model, provider, status, ms, attempts, error });

    const served = [...new Set(providers.flatMap((p) => (p.models.length ? p.models : ["gpt-4o-mini"])))];
    if (rand() < 0.02 || served.length === 0) return rec(null, 503, 1, 0, "No provider available for this model");
    const model = weighted(served, POPULARITY);
    const order = pickOrder(providers, model).sort((a, b) => a.name.localeCompare(b.name)); // pickOrder shuffles ties; keep the draw reproducible
    if (!order.length) return rec(null, 503, 1, 0, `No provider available for model '${model}'`, "(unrouted)");
    const provider = weighted(order, (p) => p.weight); // the demo keeps the traffic mix proportional to the weights
    const key = provider.nextKey();
    if (!key) return rec(null, 502, 2, 1, `${provider.name}: every key is cooling down`, model);

    const r = rand();
    const status = r < 0.955 ? 200 : r < 0.972 ? 503 : r < 0.987 ? 502 : r < 0.994 ? 400 : 429;
    const failed = status >= 500 || status === 429;
    const [lo, hi] = LATENCY[provider.name] ?? [200, 1200];
    const ms = Math.round(between(lo, hi) * (failed ? 2.2 : 1));
    if (held) (status >= 500 ? provider.recordFailure() : provider.recordSuccess()); // history must not trip a real, 15 s breaker
    const error = status === 502 ? `${provider.name}: upstream 500` : status === 503 ? "All providers are at capacity" : status === 429 ? "rate_limited" : undefined;
    const finish = () => rec(status === 502 ? null : provider.name, status, ms, failed ? 3 : rand() < 0.9 ? 1 : 2, error, model);
    if (!held) return finish();
    provider.limiter.acquire(10_000).then(
      (release) => setTimeout(() => (release(), finish()), ms),
      () => rec(null, 503, 1, 1, `${provider.name}: queue_full`, model),
    );
  }

  // an hour of plausible history, and one provider key that is resting after a rate limit
  for (let i = 0; i < 3; i++) {
    const key = providers[0].nextKey();
    if (key?.value?.endsWith("kC3d")) { key.cooldown(10 * 60_000); break; }
  }
  const t0 = Date.now();
  Object.assign(stats, { startedAt: t0 - 65 * 60_000 }); // the simulated gateway has been up as long as the history
  for (let i = 59; i >= 0; i--) {
    const n = Math.max(9, Math.round(24 + 14 * Math.sin(i / 8) + 8 * Math.sin(i / 3.1) + between(0, 12) + (i < 6 ? 18 : 0)));
    const times = Array.from({ length: n }, () => t0 - i * 60_000 + between(0, 59_000)).filter((t) => t <= t0).sort((a, b) => a - b);
    for (const ts of times) simulate(ts, false);
  }

  const fakeProvider: typeof fetch = async (input, init) => {
    const url = String(input);
    const model = (() => { try { return JSON.parse(String(init?.body)).model; } catch { return "demo"; } })();
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/chat/completions")) return json({ id: "chatcmpl-demo", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
    if (url.endsWith("/messages")) return json({ id: "msg_demo", type: "message", model, content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 2 } });
    if (url.includes(":generateContent")) return json({ candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } });
    return json({ output: { text: "pong", finish_reason: "stop" }, usage: { input: 6, output: 2 } }); // what the custom API starter expects
  };

  const modelsFor = (baseUrl: string, name?: string) => {
    const known = providers.find((p) => p.name === name);
    if (known?.models.length) return known.models;
    if (/openai\.com/.test(baseUrl)) return ["gpt-4o", "gpt-4o-mini", "o4-mini", "text-embedding-3-small"];
    if (/groq\.com/.test(baseUrl)) return ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    return ["demo-model-large", "demo-model-small"];
  };

  async function handle(method: string, path: string, body?: unknown): Promise<Reply> {
    const route = `${method} ${path}`;
    if (route === "GET /admin/api/overview") return ok({ ...buildOverview(config, providers, stats), editable: true });
    if (route === "GET /admin/api/config") return ok(describe(raw, config, env));
    if (route === "PUT /admin/api/config") {
      try {
        const merged = merge(raw, body, env);
        raw = merged.raw;
        apply(merged.config);
        return ok({ config: describe(raw, config, env), generated: merged.generated });
      } catch (e) {
        if (e instanceof ConfigError) return { status: 422, body: { error: { type: "invalid_config", message: e.message, issues: e.issues } } };
        throw e;
      }
    }
    if (route === "POST /admin/api/stats/reset") { stats.reset(); return ok({ ok: true }); }
    const reset = /^POST \/admin\/api\/providers\/([^/]+)\/reset$/.exec(route);
    if (reset) {
      const p = providers.find((x) => x.name === decodeURIComponent(reset[1]));
      if (!p) return { status: 404, body: { error: { message: "Unknown provider", type: "not_found" } } };
      p.reset();
      return ok({ ok: true });
    }
    if (route === "POST /admin/api/test") {
      const b = (body ?? {}) as { provider?: string; baseUrl?: string };
      const known = providers.find((p) => p.name === b.provider);
      const base = known?.baseUrl ?? (typeof b.baseUrl === "string" ? b.baseUrl.trim() : "");
      if (!/^https?:\/\//.test(base)) return ok({ ok: false, status: 0, ms: 0, error: "Enter a valid http(s) base URL first", models: [] });
      return ok({ ok: true, status: 200, ms: Math.round(between(90, 420)), models: modelsFor(base, b.provider) });
    }
    if (route === "POST /admin/api/test-chat") return ok(await probeChat((body ?? {}) as Record<string, unknown>, { raw }, env, fakeProvider));
    return { status: 404, body: { error: { message: "Not found", type: "not_found" } } };
  }

  return {
    handle,
    /** Live traffic: one or two requests that hold a provider slot for their latency. Called on a timer in the browser. */
    tick() { for (let i = rand() < 0.5 ? 2 : 1; i > 0; i--) simulate(Date.now(), live); },
    /** Synchronous traffic, for tests. */
    step(n: number) { for (let i = 0; i < n; i++) simulate(Date.now(), false); },
    providers,
    stats,
  };
}
