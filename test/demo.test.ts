import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDemo } from "../demo/mock-api.ts";

type Obj = Record<string, any>;
const get = async (d: ReturnType<typeof createDemo>, path: string) => (await d.handle("GET", path)).body as Obj;
const draftOf = (cfg: Obj) => ({
  settings: cfg.settings,
  providers: cfg.providers.map((p: Obj) => ({ ...p, originalName: p.name, keys: p.keys.map((_: unknown, i: number) => ({ keep: i })) })),
  clients: cfg.clients.map((c: Obj) => ({ ...c, originalName: c.name, key: { keep: true } })),
});

test("the demo starts with believable history, four providers and one key resting", async () => {
  const d = createDemo({ seed: 1 });
  const o = await get(d, "/admin/api/overview");
  assert.equal(o.editable, true);
  assert.ok(o.totals.total > 1000 && o.totals.failed > 0 && o.totals.successRate > 0.9);
  assert.deepEqual(o.providers.map((p: Obj) => [p.name, p.format]), [["openai", "openai"], ["claude", "anthropic"], ["groq", "openai"], ["local-ollama", "openai"]]);
  assert.equal(o.series.length, 60);
  assert.ok(o.providers[0].keys.some((k: Obj) => k.cooldownSec > 0), "one OpenAI key is cooling down");
  assert.ok(o.recent.length === 200 && o.models.length >= 5);
});

test("never exposes the keys it was built with", async () => {
  const d = createDemo({ seed: 1 });
  const text = JSON.stringify([await get(d, "/admin/api/overview"), await get(d, "/admin/api/config")]);
  for (const secret of ["sk-proj-demo-7f3a91b2", "sk-proj-demo-e5c4kC3d", "gw_demo_web_4f9c2a7e1b8d3c6a", "demo-env-value-0000"]) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.match(text, /••••kC3d/);
});

test("saving settings uses the real validation and applies at once", async () => {
  const d = createDemo({ seed: 1 });
  const cfg = await get(d, "/admin/api/config");
  assert.equal((await d.handle("PUT", "/admin/api/config", draftOf(cfg))).status, 200, "an untouched draft saves");

  const bad = draftOf(cfg);
  bad.providers[0].baseUrl = "ftp://nope";
  bad.providers[1].name = "openai";
  const res = await d.handle("PUT", "/admin/api/config", bad);
  assert.equal(res.status, 422);
  const paths = (res.body as Obj).error.issues.map((i: Obj) => i.path);
  assert.ok(paths.includes("providers[0].baseUrl") && paths.includes("providers[1].name"), String(paths));

  const next = draftOf(cfg);
  next.providers.push({ name: "mistral", baseUrl: "https://api.mistral.ai/v1", weight: 1, maxConcurrent: 4, queueSize: 8, models: ["mistral-large"], keys: [{ value: "env:MISTRAL_API_KEY" }] });
  next.clients.push({ name: "ci-bot", ratePerMinute: 30, key: { generate: true } });
  const saved = await d.handle("PUT", "/admin/api/config", next);
  assert.equal(saved.status, 200);
  assert.equal((saved.body as Obj).generated[0].name, "ci-bot");
  assert.equal((await get(d, "/admin/api/overview")).providers.length, 5);
});

test("changing a weight changes where the simulated traffic goes", async () => {
  // llama-3.1-8b-instant is served by both groq and local-ollama, so their weights decide the split
  const share = (d: ReturnType<typeof createDemo>) => {
    const rows = d.stats.recent.slice(-400).filter((r) => r.model === "llama-3.1-8b-instant" && r.provider);
    return rows.filter((r) => r.provider === "local-ollama").length / rows.length;
  };
  const d = createDemo({ seed: 3 });
  d.step(400);
  const before = share(d);
  const cfg = draftOf(await get(d, "/admin/api/config"));
  cfg.providers.find((p: Obj) => p.name === "local-ollama").weight = 1000;
  assert.equal((await d.handle("PUT", "/admin/api/config", cfg)).status, 200);
  d.step(400);
  const after = share(d);
  assert.ok(before < 0.6 && after > 0.85, `local-ollama share went from ${before.toFixed(2)} to ${after.toFixed(2)}`);
});

test("Send test message runs the real adapters against a simulated provider", async () => {
  const d = createDemo({ seed: 1 });
  const claude = (await d.handle("POST", "/admin/api/test-chat", { originalName: "claude", baseUrl: "https://api.anthropic.com/v1", format: "anthropic", model: "claude-sonnet-4-5", key: { keep: 0 } })).body as Obj;
  assert.equal(claude.ok, true);
  assert.equal(claude.reply, "pong");
  assert.equal(claude.sent.url, "https://api.anthropic.com/v1/messages");
  assert.match(claude.sent.headers["x-api-key"], /^••••/, "the key is masked even in the demo");

  const gemini = (await d.handle("POST", "/admin/api/test-chat", { baseUrl: "https://generativelanguage.googleapis.com/v1beta", format: "gemini", model: "gemini-2.0-flash", key: "x" })).body as Obj;
  assert.equal(gemini.reply, "pong");

  const wrong = (await d.handle("POST", "/admin/api/test-chat", { baseUrl: "https://api.acme.example", format: "custom", model: "m", adapter: { path: "/x", request: { a: "{{model}}" }, response: { text: "nothing.here" } } })).body as Obj;
  assert.equal(wrong.ok, false);
  assert.match(wrong.received, /pong/, "a wrong mapping shows the raw answer so it can be fixed");
});

test("quick actions work: reset a provider and the statistics", async () => {
  const d = createDemo({ seed: 1 });
  assert.equal((await d.handle("POST", "/admin/api/providers/openai/reset")).status, 200);
  assert.ok(!(await get(d, "/admin/api/overview")).providers[0].keys.some((k: Obj) => k.cooldownSec > 0));
  assert.equal((await d.handle("POST", "/admin/api/providers/nope/reset")).status, 404);
  await d.handle("POST", "/admin/api/stats/reset");
  assert.equal((await get(d, "/admin/api/overview")).totals.total, 0);
});

test("the static build is complete, and the compiled bundle runs", async () => {
  const { build } = (await import(new URL("../demo/build.mjs", import.meta.url).href)) as { build: (dir: string) => string };
  const out = build(mkdtempSync(join(tmpdir(), "demo-")));
  for (const f of ["index.html", "main.js", "ui.js", "mock-api.js", "adapters.js", "configAdmin.js", "pool.js", "_headers"]) assert.ok(existsSync(join(out, f)), `${f} missing`);
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.match(html, /<title>llm-gateway · Live demo<\/title>/);
  assert.match(html, /src="main\.js"/);
  assert.match(html, /window\.__demoReady/);
  assert.match(readFileSync(join(out, "_headers"), "utf8"), /default-src 'none'/);
  assert.ok(!/from "[^"]+\.ts"/.test(readFileSync(join(out, "mock-api.js"), "utf8")), "no .ts imports left in the bundle");

  const built = (await import(pathToFileURL(join(out, "mock-api.js")).href)) as { createDemo: typeof createDemo };
  const o = (await built.createDemo({ seed: 1 }).handle("GET", "/admin/api/overview")).body as Obj;
  assert.equal(o.providers.length, 4);
});
