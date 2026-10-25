import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mask, resolveSecret, withDefaults, type Config, type ConfigInput, type ProviderConfig } from "./config.ts";

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
      if (existsSync(path)) copyFileSync(path, `${path}.bak`);
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
      keys: (raw.providers[i]?.keys ?? []).map((k) => secretView(k, env)),
    })),
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
