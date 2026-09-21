import { readFileSync } from "node:fs";

export type ProviderConfig = {
  name: string;
  baseUrl: string;
  /** Upstream API keys. Use "env:NAME" to read from the environment. Empty = no auth (e.g. Ollama). */
  keys?: string[];
  weight?: number;
  maxConcurrent?: number;
  queueSize?: number;
  /** Models served by this provider. Empty/omitted = any model. */
  models?: string[];
};

export type ClientKeyConfig = {
  name: string;
  /** Use "env:NAME" to read from the environment. */
  key: string;
  ratePerMinute?: number;
};

export type Config = {
  port: number;
  clientKeys: ClientKeyConfig[];
  providers: ProviderConfig[];
  upstreamTimeoutMs: number;
  queueTimeoutMs: number;
  maxAttempts: number;
  breaker: { failures: number; cooldownMs: number };
  keyCooldownMs: number;
};

export type ConfigInput = Partial<Omit<Config, "providers">> & { providers: ProviderConfig[] };

export function resolveSecret(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const v = env[name];
  if (!v) throw new Error(`Environment variable ${name} is not set`);
  return v;
}

export function withDefaults(input: ConfigInput, env: NodeJS.ProcessEnv = process.env): Config {
  if (!input.providers?.length) throw new Error("Config needs at least one provider");
  return {
    port: input.port ?? 8080,
    clientKeys: (input.clientKeys ?? []).map((c) => ({
      ...c,
      key: resolveSecret(c.key, env),
      ratePerMinute: c.ratePerMinute ?? 60,
    })),
    providers: input.providers.map((p) => ({
      ...p,
      keys: (p.keys ?? []).map((k) => resolveSecret(k, env)),
      weight: p.weight ?? 1,
      maxConcurrent: p.maxConcurrent ?? 8,
      queueSize: p.queueSize ?? 32,
      models: p.models ?? [],
    })),
    upstreamTimeoutMs: input.upstreamTimeoutMs ?? 60_000,
    queueTimeoutMs: input.queueTimeoutMs ?? 10_000,
    maxAttempts: input.maxAttempts ?? 3,
    breaker: input.breaker ?? { failures: 3, cooldownMs: 15_000 },
    keyCooldownMs: input.keyCooldownMs ?? 30_000,
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  return withDefaults(JSON.parse(readFileSync(path, "utf8")), env);
}
