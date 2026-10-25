import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { withDefaults, type ConfigInput } from "../src/config.ts";
import { fileStore } from "../src/configAdmin.ts";
import { createGateway } from "../src/server.ts";

type After = { after: (fn: () => void) => void };
const ENV = { UP_KEY: "env-upstream-secret-0000" };
const ADMIN = "admin-secret-key";

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function upstream(t: After, tag: string) {
  const seen: { url?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/models" ? { data: [{ id: "m-a" }, { id: "m-b" }] } : { from: tag }));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: await listen(server), seen };
}

async function setup(t: After, input: Partial<ConfigInput> & Pick<ConfigInput, "providers">, withStore = true) {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const path = join(dir, "config.json");
  const raw: ConfigInput = { adminKey: ADMIN, ...input };
  const store = fileStore(path, raw);
  if (withStore) store.save(raw);
  const gw = createGateway(withDefaults(raw, ENV), { log: false, store: withStore ? store : undefined, env: ENV });
  t.after(() => {
    gw.server.closeAllConnections();
    gw.server.close();
  });
  const url = await listen(gw.server);
  const api = (method: string, path: string, body?: unknown, key = ADMIN) =>
    fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...gw, url, api, path, read: () => JSON.parse(readFileSync(path, "utf8")) as ConfigInput };
}

/** What the settings screen sends back when nothing but the draft changed. */
type Desc = Awaited<ReturnType<typeof getConfig>>;
async function getConfig(gw: { api: (m: string, p: string) => Promise<Response> }) {
  return (await (await gw.api("GET", "/admin/api/config")).json()) as {
    settings: Record<string, unknown>;
    providers: { name: string; keys: unknown[]; [k: string]: unknown }[];
    clients: { name: string; [k: string]: unknown }[];
  };
}
const draft = (d: Desc) => ({
  settings: d.settings,
  providers: d.providers.map((p) => ({ ...p, originalName: p.name, keys: p.keys.map((_, i) => ({ keep: i })) })),
  clients: d.clients.map((c) => ({ ...c, originalName: c.name, key: { keep: true } })),
});
const chat = (url: string, key?: string) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: "m" }) });

test("config API needs the admin key and a config file", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, { providers: [{ name: "a", baseUrl: up.url }] });
  assert.equal((await gw.api("GET", "/admin/api/config", undefined, "nope")).status, 401);

  const ro = await setup(t, { providers: [{ name: "a", baseUrl: up.url }] }, false);
  assert.equal((await ro.api("GET", "/admin/api/config")).status, 501);
  assert.equal(((await (await ro.api("GET", "/admin/api/overview")).json()) as { editable: boolean }).editable, false);
});

test("describes the config with every secret masked", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, {
    clientKeys: [{ name: "team", key: "client-secret-key-1234", ratePerMinute: 10 }],
    providers: [{ name: "a", baseUrl: up.url, keys: ["env:UP_KEY", "sk-inline-secret-9876"] }],
  });
  const text = await (await gw.api("GET", "/admin/api/config")).text();
  for (const secret of ["env-upstream-secret-0000", "sk-inline-secret-9876", "client-secret-key-1234"]) assert.ok(!text.includes(secret), `${secret} leaked`);
  const d = JSON.parse(text);
  assert.deepEqual(d.providers[0].keys, [{ source: "env", ref: "env:UP_KEY", masked: "••••0000" }, { source: "inline", masked: "••••9876" }]);
  assert.deepEqual(d.clients[0].key, { source: "inline", masked: "••••1234" });
});

test("saving an untouched draft keeps secrets, env references and live provider state", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, {
    clientKeys: [{ name: "team", key: "client-secret-key-1234" }],
    providers: [{ name: "a", baseUrl: up.url, keys: ["env:UP_KEY", "sk-inline-secret-9876"] }],
  });
  const before = gw.providers[0];
  const res = await gw.api("PUT", "/admin/api/config", draft(await getConfig(gw)));
  assert.equal(res.status, 200);
  const saved = gw.read();
  assert.deepEqual(saved.providers[0].keys, ["env:UP_KEY", "sk-inline-secret-9876"]);
  assert.equal(saved.clientKeys?.[0].key, "client-secret-key-1234");
  assert.equal(saved.adminKey, ADMIN);
  assert.equal(gw.providers[0], before, "unchanged provider should be reused");
  assert.equal((await chat(gw.url, "client-secret-key-1234")).status, 200);
  assert.equal(up.seen.at(-1)?.auth, "Bearer env-upstream-secret-0000");
});

test("adds a provider and a client, applies them live and writes the file", async (t) => {
  const a = await upstream(t, "a");
  const b = await upstream(t, "b");
  const gw = await setup(t, { clientKeys: [{ name: "old", key: "client-secret-key-1234" }], providers: [{ name: "a", baseUrl: a.url, models: ["only-a"] }] });
  const d = draft(await getConfig(gw));
  d.providers.push({ originalName: undefined, name: "b", baseUrl: b.url, weight: 1, maxConcurrent: 2, queueSize: 2, models: ["m"], keys: [{ value: "sk-new-provider-key" }] } as never);
  d.clients.push({ originalName: undefined, name: "fresh", ratePerMinute: 5, key: { generate: true } } as never);
  const res = await gw.api("PUT", "/admin/api/config", d);
  assert.equal(res.status, 200);
  const { generated, config } = (await res.json()) as { generated: { name: string; key: string }[]; config: Desc };

  assert.equal(generated.length, 1);
  assert.equal(generated[0].name, "fresh");
  assert.ok(existsSync(`${gw.path}.bak`), "previous file kept as .bak");
  assert.equal(gw.read().providers.length, 2);
  assert.equal(JSON.stringify(config).includes(generated[0].key), false, "generated key is shown once only");
  assert.equal(JSON.stringify(await getConfig(gw)).includes(generated[0].key), false);

  const ok = await chat(gw.url, generated[0].key); // new client works at once, routed to the new provider (only one serving "m")
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-gateway-provider"), "b");
  assert.equal(b.seen.at(-1)?.auth, "Bearer sk-new-provider-key");
  assert.equal((await chat(gw.url, "client-secret-key-1234")).status, 200);
});

test("removing a provider or client takes effect immediately", async (t) => {
  const a = await upstream(t, "a");
  const b = await upstream(t, "b");
  const gw = await setup(t, {
    clientKeys: [{ name: "x", key: "client-secret-key-xxxx" }, { name: "y", key: "client-secret-key-yyyy" }],
    providers: [{ name: "a", baseUrl: a.url }, { name: "b", baseUrl: b.url, weight: 1000 }],
  });
  const d = draft(await getConfig(gw));
  d.providers = d.providers.filter((p) => p.name !== "b");
  d.clients = d.clients.filter((c) => c.name !== "y");
  assert.equal((await gw.api("PUT", "/admin/api/config", d)).status, 200);
  assert.equal((await chat(gw.url, "client-secret-key-yyyy")).status, 401);
  assert.equal((await chat(gw.url, "client-secret-key-xxxx")).headers.get("x-gateway-provider"), "a");
});

test("rejects invalid drafts with per-field messages and changes nothing", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, { clientKeys: [{ name: "c", key: "client-secret-key-1234" }], providers: [{ name: "a", baseUrl: up.url }] });
  const before = readFileSync(gw.path, "utf8");
  const d = draft(await getConfig(gw));
  d.providers.push({ name: "a", baseUrl: "ftp://nope", weight: 0, maxConcurrent: 2, queueSize: 2, models: [], keys: [{ value: "env:NOT_SET_ANYWHERE" }] } as never);
  d.clients.push({ name: "c", ratePerMinute: 5, key: { value: "short" } } as never);
  d.settings.maxAttempts = 0;
  const res = await gw.api("PUT", "/admin/api/config", d);
  assert.equal(res.status, 422);
  const paths = ((await res.json()) as { error: { issues: { path: string }[] } }).error.issues.map((i) => i.path);
  for (const p of ["settings.maxAttempts", "providers[1].name", "providers[1].baseUrl", "providers[1].weight", "providers[1].keys[0]", "clients[1].name", "clients[1].key"]) {
    assert.ok(paths.includes(p), `expected an issue for ${p}, got ${paths}`);
  }
  assert.equal(readFileSync(gw.path, "utf8"), before);
  assert.equal(gw.providers.length, 1);
});

test("turning authentication off needs explicit confirmation", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, { clientKeys: [{ name: "c", key: "client-secret-key-1234" }], providers: [{ name: "a", baseUrl: up.url }] });
  const d = { ...draft(await getConfig(gw)), clients: [] };
  assert.equal((await gw.api("PUT", "/admin/api/config", d)).status, 422);
  assert.equal((await chat(gw.url)).status, 401);
  assert.equal((await gw.api("PUT", "/admin/api/config", { ...d, allowNoAuth: true })).status, 200);
  assert.equal((await chat(gw.url)).status, 200);
});

test("tests a provider connection and lists its models", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, { providers: [{ name: "a", baseUrl: up.url, keys: ["sk-for-probe-1111"] }] });
  const known = (await (await gw.api("POST", "/admin/api/test", { provider: "a" })).json()) as { ok: boolean; models: string[] };
  assert.deepEqual([known.ok, known.models], [true, ["m-a", "m-b"]]);
  assert.equal(up.seen.at(-1)?.url, "/models");
  assert.equal(up.seen.at(-1)?.auth, "Bearer sk-for-probe-1111");
  const typed = (await (await gw.api("POST", "/admin/api/test", { baseUrl: up.url, key: "env:UP_KEY" })).json()) as { ok: boolean };
  assert.equal(typed.ok, true);
  assert.equal(up.seen.at(-1)?.auth, "Bearer env-upstream-secret-0000");
  const bad = (await (await gw.api("POST", "/admin/api/test", { baseUrl: "http://127.0.0.1:1" })).json()) as { ok: boolean; error: string };
  assert.deepEqual([bad.ok, typeof bad.error], [false, "string"]);
});

test("resets a provider's breaker and the statistics", async (t) => {
  const dead = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end("{}");
  });
  t.after(() => {
    dead.closeAllConnections();
    dead.close();
  });
  const gw = await setup(t, { breaker: { failures: 1, cooldownMs: 60_000 }, providers: [{ name: "d", baseUrl: await listen(dead) }] });
  await chat(gw.url);
  assert.equal(gw.providers[0].breakerOpen, true);
  assert.equal((await gw.api("POST", "/admin/api/providers/d/reset")).status, 200);
  assert.equal(gw.providers[0].breakerOpen, false);
  assert.equal((await gw.api("POST", "/admin/api/providers/nope/reset")).status, 404);
  assert.ok(gw.stats.total > 0);
  assert.equal((await gw.api("POST", "/admin/api/stats/reset")).status, 200);
  assert.equal(gw.stats.total, 0);
});

/* ---------- API formats ---------- */

async function claudeLike(t: After) {
  const seen: { url?: string; key?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["x-api-key"] as string, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: await listen(server), seen };
}

test("describes each provider's API format and offers the presets", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, { providers: [{ name: "a", baseUrl: up.url, format: "gemini" }, { name: "b", baseUrl: up.url }] });
  const d = (await getConfig(gw)) as Desc & { meta: { formats: string[]; presets: Record<string, unknown>; variables: Record<string, string> } };
  assert.deepEqual(d.providers.map((p) => p.format), ["gemini", "openai"]);
  assert.deepEqual(Object.keys(d.meta.presets), ["anthropic", "gemini"]);
  assert.ok("messages" in d.meta.variables);
});

test("switching a provider to another API format takes effect at once", async (t) => {
  const claude = await upstream(t, "x");
  const real = await claudeLike(t);
  const gw = await setup(t, { providers: [{ name: "c", baseUrl: claude.url, keys: ["sk-ant-1"], models: ["m"] }] });
  const d = draft(await getConfig(gw));
  Object.assign(d.providers[0], { baseUrl: real.url, format: "anthropic" });
  assert.equal((await gw.api("PUT", "/admin/api/config", d)).status, 200);
  assert.equal(gw.read().providers[0].format, "anthropic");
  assert.equal(gw.read().providers[0].adapter, undefined, "a preset needs no stored mapping");
  const res = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content, "pong");
  assert.equal(real.seen[0].url, "/messages");
  assert.equal(real.seen[0].key, "sk-ant-1");
});

test("saves a custom adapter and rejects a broken one with the field path", async (t) => {
  const up = await upstream(t, "a");
  const gw = await setup(t, { providers: [{ name: "a", baseUrl: up.url }] });
  const d = draft(await getConfig(gw));
  const p = d.providers[0] as Record<string, unknown>;
  p.format = "custom";
  p.adapter = { path: "oops", request: { q: "{{nope}}" }, response: { text: "a..b" } };
  const res = await gw.api("PUT", "/admin/api/config", d);
  assert.equal(res.status, 422);
  const paths = ((await res.json()) as { error: { issues: { path: string }[] } }).error.issues.map((i) => i.path);
  for (const f of ["providers[0].adapter.path", "providers[0].adapter.request", "providers[0].adapter.response.text"]) assert.ok(paths.includes(f), `${f} in ${paths}`);
  assert.equal(gw.read().providers[0].format, undefined);

  p.adapter = { path: "/talk", auth: { header: "X-Key", scheme: "" }, request: { q: "{{last_user}}" }, response: { text: "out" } };
  assert.equal((await gw.api("PUT", "/admin/api/config", d)).status, 200);
  assert.equal(gw.read().providers[0].adapter?.path, "/talk");
  assert.equal(((await getConfig(gw)).providers[0] as Record<string, unknown>).format, "custom");
});

test("sends a test message and shows what went out, what came back and the translation", async (t) => {
  const real = await claudeLike(t);
  const gw = await setup(t, { providers: [{ name: "c", baseUrl: real.url, format: "anthropic", keys: ["sk-ant-secret-1234"] }] });

  const ok = (await (await gw.api("POST", "/admin/api/test-chat", { originalName: "c", baseUrl: real.url, format: "anthropic", model: "claude-x", key: { keep: 0 } })).json()) as Record<string, any>;
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, "pong");
  assert.equal(ok.sent.url, `${real.url}/messages`);
  assert.equal(JSON.parse(ok.sent.body).model, "claude-x");
  assert.equal(ok.sent.headers["x-api-key"], "••••1234");
  assert.ok(!JSON.stringify(ok).includes("sk-ant-secret-1234"), "the key must not come back");
  assert.equal(real.seen[0].key, "sk-ant-secret-1234");
  assert.equal(ok.openai.choices[0].message.content, "pong");

  const wrong = (await (await gw.api("POST", "/admin/api/test-chat", { baseUrl: real.url, format: "custom", model: "m", adapter: { path: "/x", request: { a: "{{model}}" }, response: { text: "nothing.here" } } })).json()) as Record<string, any>;
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /response mapping/);
  assert.match(wrong.received, /pong/, "the raw answer is shown so the mapping can be fixed");

  const invalid = (await (await gw.api("POST", "/admin/api/test-chat", { baseUrl: real.url, format: "custom", model: "m", adapter: { path: "x" } })).json()) as Record<string, any>;
  assert.match(invalid.error, /Fix the format first/);
});
