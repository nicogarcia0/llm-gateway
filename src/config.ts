import { readFileSync } from "node:fs";

export type ProviderConfig = {
  name: string;
  baseUrl: string;
  keys?: string[];
  weight?: number;
  maxConcurrent?: number;
  queueSize?: number;
  models?: string[];
};

export type ClientKeyConfig = {
  name: string;
  key: string;
  ratePerMinute?: number;
};

export type Config = {
  port: number;
  /** Enables the /admin dashboard. Unset = dashboard disabled. */
  adminKey?: string;
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

export const mask = (s: string) => (s.length > 8 ? `••••${s.slice(-4)}` : "••••");

export function withDefaults(input: ConfigInput, env: NodeJS.ProcessEnv = process.env): Config {
  if (!input.providers?.length) throw new Error("Config needs at least one provider");
  return {
    port: input.port ?? 8080,
    adminKey: input.adminKey ? resolveSecret(input.adminKey, env) : undefined,
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

export function loadRaw(path: string): ConfigInput {
  return JSON.parse(readFileSync(path, "utf8"));
}
