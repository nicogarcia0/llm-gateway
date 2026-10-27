import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mask, resolveSecret, withDefaults, type Config, type ConfigInput, type ProviderConfig } from "./config.ts";
import { CUSTOM_STARTER, FORMATS, PRESETS, VARIABLES, buildUpstream, resolveAdapter, toOpenAI, validateAdapter, type AdapterConfig, type Format } from "./adapters.ts";

/** Where the editable config lives. `raw` is the file as written (with `env:` references), never the resolved secrets. */
export type Store = { raw: ConfigInput; save(next: ConfigInput): void };
export type Issue = { path: string; message: string };

export class ConfigError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues[0]?.message ?? "Invalid config");
    this.issues = issues;
  }
}

export function fileStore(path: string, raw: ConfigInput): Store {
  return {
    raw,
    save(next) {
      // written in place: a single-file Docker bind mount cannot be replaced by rename
      try {
        if (existsSync(path)) copyFileSync(path, `${path}.bak`);
      } catch {} // best effort: a read-only folder must not block a valid save
      writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      this.raw = next;
    },
  };
}

const secretView = (v: string, env: NodeJS.ProcessEnv) =>
  v.startsWith("env:")
    ? { source: "env" as const, ref: v, masked: env[v.slice(4)] ? mask(env[v.slice(4)]!) : "not set" }
    : { source: "inline" as const, masked: mask(v) };

/** What the settings screen edits. Secrets are masked; the browser only ever sees `keep` handles for them. */
export function describe(raw: ConfigInput, config: Config, env: NodeJS.ProcessEnv) {
  return {
    settings: {
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      queueTimeoutMs: config.queueTimeoutMs,
      maxAttempts: config.maxAttempts,
      breaker: config.breaker,
      keyCooldownMs: config.keyCooldownMs,
    },
    providers: config.providers.map((p, i) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      weight: p.weight!,
      maxConcurrent: p.maxConcurrent!,
      queueSize: p.queueSize!,
      models: p.models!,
      format: p.format ?? "openai",
      adapter: p.adapter ?? null,
      keys: (raw.providers[i]?.keys ?? []).map((k) => secretView(k, env)),
    })),
    meta: { formats: FORMATS, presets: PRESETS, starter: CUSTOM_STARTER, variables: VARIABLES },
    clients: config.clientKeys.map((c, i) => ({
      name: c.name,
      ratePerMinute: c.ratePerMinute!,
      key: secretView(raw.clientKeys?.[i]?.key ?? "", env),
    })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Applies an edited draft from the settings screen on top of the stored config.
 * Existing secrets are referenced by position (`{keep}`), new ones arrive as `{value}`; nothing secret round-trips.
 */
export function merge(raw: ConfigInput, body: unknown, env: NodeJS.ProcessEnv) {
  const issues: Issue[] = [];
  const bad = (path: string, message: string) => void issues.push({ path, message });
  const num = (path: string, v: unknown, min: number, max: number, int = true) => {
    if (typeof v === "number" && Number.isFinite(v) && (!int || Number.isInteger(v)) && v >= min && v <= max) return v;
    bad(path, `Enter ${int ? "a whole number" : "a number"} between ${min} and ${max}`);
    return min;
  };
  const str = (path: string, v: unknown, max: number) => {
    if (typeof v === "string" && v.trim() && v.trim().length <= max) return v.trim();
    bad(path, v === undefined || v === "" ? "Required" : `Required, up to ${max} characters`);
    return "";
  };
  const envOk = (path: string, v: string) => {
    if (v.startsWith("env:") && !env[v.slice(4)]) bad(path, `Environment variable ${v.slice(4)} is not set`);
  };

  if (!isObj(body)) throw new ConfigError([{ path: "", message: "Body must be a JSON object" }]);
  const s = isObj(body.settings) ? body.settings : {};
  const br = isObj(s.breaker) ? s.breaker : {};
  const next: ConfigInput = {
    ...raw,
    upstreamTimeoutMs: num("settings.upstreamTimeoutMs", s.upstreamTimeoutMs, 1_000, 600_000),
    queueTimeoutMs: num("settings.queueTimeoutMs", s.queueTimeoutMs, 100, 600_000),
    maxAttempts: num("settings.maxAttempts", s.maxAttempts, 1, 20),
    breaker: { failures: num("settings.breaker.failures", br.failures, 1, 100), cooldownMs: num("settings.breaker.cooldownMs", br.cooldownMs, 1_000, 3_600_000) },
    keyCooldownMs: num("settings.keyCooldownMs", s.keyCooldownMs, 1_000, 86_400_000),
    providers: [],
  };

  const providerList = Array.isArray(body.providers) ? body.providers : [];
  if (!providerList.length) bad("providers", "Add at least one provider");
  const names = new Set<string>();
  next.providers = providerList.map((p: unknown, i: number): ProviderConfig => {
    const at = `providers[${i}]`;
    if (!isObj(p)) {
      bad(at, "Invalid provider");
      return { name: "", baseUrl: "" };
    }
    const name = str(`${at}.name`, p.name, 40);
    if (name && !/^[\w.-]+$/.test(name)) bad(`${at}.name`, "Use letters, numbers, dot, dash or underscore");
    if (name && names.has(name)) bad(`${at}.name`, "Another provider already uses this name");
    names.add(name);
    const baseUrl = str(`${at}.baseUrl`, p.baseUrl, 300);
    if (baseUrl) {
      try {
        if (!/^https?:$/.test(new URL(baseUrl).protocol)) throw new Error();
      } catch {
        bad(`${at}.baseUrl`, "Must be a valid http(s) URL");
      }
    }
    const old = typeof p.originalName === "string" ? raw.providers.find((x) => x.name === p.originalName) : undefined;
    const keys = (Array.isArray(p.keys) ? p.keys : []).map((k: unknown, j: number) => {
      const kat = `${at}.keys[${j}]`;
      if (isObj(k) && typeof k.keep === "number") {
        const kept = old?.keys?.[k.keep];
        if (kept === undefined) bad(kat, "This key no longer exists, reload the page");
        return kept ?? "";
      }
      const v = str(kat, isObj(k) ? k.value : undefined, 500);
      envOk(kat, v);
      return v;
    });
    let format: Format = "openai";
    if (p.format !== undefined && p.format !== null) {
      if (FORMATS.includes(p.format as Format)) format = p.format as Format;
      else bad(`${at}.format`, `Unknown API format "${String(p.format)}"`);
    }
    let adapter: AdapterConfig | undefined;
    if (format !== "openai") {
      if (p.adapter !== undefined && p.adapter !== null && !isObj(p.adapter)) bad(`${at}.adapter`, "Invalid adapter");
      else if (isObj(p.adapter)) {
        const a = p.adapter as AdapterConfig;
        adapter = { path: a.path, auth: a.auth, headers: a.headers, defaults: a.defaults, request: a.request, response: a.response, streaming: a.streaming };
        if (JSON.stringify(adapter).length > 40_000) bad(`${at}.adapter`, "Adapter is too large");
      }
      for (const issue of validateAdapter(resolveAdapter(format, adapter))) bad(`${at}.adapter.${issue.path}`, issue.message);
    }
    const models = [...new Set((Array.isArray(p.models) ? p.models : []).map((m: unknown) => (typeof m === "string" ? m.trim() : "")).filter(Boolean))].slice(0, 200) as string[];
    return {
      ...old,
      name,
      baseUrl,
      weight: num(`${at}.weight`, p.weight, 0.1, 1_000, false),
      maxConcurrent: num(`${at}.maxConcurrent`, p.maxConcurrent, 1, 1_000),
      queueSize: num(`${at}.queueSize`, p.queueSize, 0, 10_000),
      models,
      keys,
      format: format === "openai" ? undefined : format,
      adapter,
    };
  });

  const generated: { name: string; key: string }[] = [];
  const clientList = Array.isArray(body.clients) ? body.clients : [];
  const clientNames = new Set<string>();
  const seenKeys = new Map<string, string>();
  let adminKey: string | undefined;
  try {
    adminKey = next.adminKey ? resolveSecret(next.adminKey, env) : undefined;
  } catch {}
  next.clientKeys = clientList.map((c: unknown, i: number) => {
    const at = `clients[${i}]`;
    if (!isObj(c)) {
      bad(at, "Invalid client");
      return { name: "", key: "" };
    }
    const name = str(`${at}.name`, c.name, 40);
    if (name && clientNames.has(name)) bad(`${at}.name`, "Another client already uses this name");
    clientNames.add(name);
    const old = typeof c.originalName === "string" ? raw.clientKeys?.find((x) => x.name === c.originalName) : undefined;
    const spec = isObj(c.key) ? c.key : {};
    let key = "";
    if (spec.keep === true) {
      key = old?.key ?? "";
      if (!key) bad(`${at}.key`, "This key no longer exists, reload the page");
    } else if (spec.generate === true) {
      key = "gw_" + randomBytes(24).toString("base64url");
      generated.push({ name, key });
    } else {
      key = str(`${at}.key`, spec.value, 500);
      if (key && !key.startsWith("env:") && key.length < 16) bad(`${at}.key`, "Use at least 16 characters");
      envOk(`${at}.key`, key);
    }
    let resolved = key;
    try {
      resolved = resolveSecret(key, env);
    } catch {}
    if (resolved && resolved === adminKey) bad(`${at}.key`, "Must differ from the admin key");
    const other = seenKeys.get(resolved);
    if (resolved && other !== undefined) bad(`${at}.key`, `Same key as client "${other}"`);
    seenKeys.set(resolved, name);
    return { ...old, name, key, ratePerMinute: num(`${at}.ratePerMinute`, c.ratePerMinute, 1, 100_000) };
  });
  if (raw.clientKeys?.length && !next.clientKeys.length && body.allowNoAuth !== true) {
    bad("clients", "Removing every client key turns authentication off. Confirm to continue.");
  }

  if (issues.length) throw new ConfigError(issues);
  let config: Config;
  try {
    config = withDefaults(next, env);
  } catch (e) {
    throw new ConfigError([{ path: "", message: e instanceof Error ? e.message : String(e) }]);
  }
  return { raw: next, config, generated };
}

/**
 * Sends one sample chat message through a provider definition that may not be saved yet, and reports what was
 * sent, what came back and how it was translated. This is how you debug a custom adapter.
 */
export async function probeChat(b: Record<string, unknown>, store: Pick<Store, "raw"> | undefined, env: NodeJS.ProcessEnv, doFetch: typeof fetch = fetch) {
  const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ok: false, status: 0, ms: 0, error, ...extra });
  const base = typeof b.baseUrl === "string" ? b.baseUrl.trim().replace(/\/$/, "") : "";
  if (!/^https?:\/\//.test(base)) return fail("Enter a valid http(s) base URL first");
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!model) return fail("Enter a model name to test with");
  const format = FORMATS.includes(b.format as Format) ? (b.format as Format) : "openai";
  const spec = resolveAdapter(format, isObj(b.adapter) ? (b.adapter as AdapterConfig) : undefined);
  const issue = validateAdapter(spec)[0];
  if (issue) return fail(`Fix the format first: ${issue.path}: ${issue.message}`);

  let key: string | null = null;
  try {
    const k = b.key;
    if (typeof k === "string" && k.trim()) key = resolveSecret(k.trim(), env);
    else if (isObj(k) && typeof k.keep === "number") {
      const stored = store?.raw.providers.find((p) => p.name === b.originalName)?.keys?.[k.keep];
      if (stored) key = resolveSecret(stored, env);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const sample = { model, max_tokens: 64, messages: [{ role: "user", content: typeof b.message === "string" && b.message.trim() ? b.message.slice(0, 500) : "Reply with the single word: pong" }] };
  const sent = spec
    ? buildUpstream(spec, sample, base, key, false)
    : { url: `${base}/chat/completions`, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(sample) };
  const shownHeaders = Object.fromEntries(Object.entries(sent.headers).map(([k, v]) => [k, key && v.includes(key) ? v.replace(key, mask(key)) : v]));
  const view = { url: sent.url, headers: shownHeaders, body: JSON.stringify(JSON.parse(sent.body), null, 2) };

  const t0 = Date.now();
  try {
    const r = await doFetch(sent.url, { method: "POST", headers: sent.headers, body: sent.body, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let reply: string | undefined, openai: unknown = null;
    try {
      const json = JSON.parse(text);
      if (spec) {
        openai = toOpenAI(spec, json, model);
        reply = (openai as { choices: { message: { content: string } }[] } | null)?.choices[0].message.content;
      } else reply = json?.choices?.[0]?.message?.content;
    } catch {}
    const ok = r.ok && typeof reply === "string";
    return {
      ok, status: r.status, ms: Date.now() - t0, sent: view, received: text.slice(0, 4000), reply: reply ?? null, openai,
      error: ok ? undefined : r.ok ? "The provider answered, but no reply text was found. Check the response mapping against the raw answer below." : `The provider answered ${r.status}`,
    };
  } catch (e) {
    return fail(e instanceof Error && e.name === "TimeoutError" ? "Timed out after 20s" : "Could not connect", { ms: Date.now() - t0, sent: view });
  }
}
