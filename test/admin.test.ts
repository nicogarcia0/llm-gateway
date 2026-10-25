import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { withDefaults, type ConfigInput } from "../src/config.ts";
import { createGateway } from "../src/server.ts";

type After = { after: (fn: () => void) => void };

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function upstream(t: After, handler: http.RequestListener) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    handler(req, res);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: await listen(server), hits: () => hits };
}

async function gateway(t: After, input: ConfigInput) {
  const gw = createGateway(withDefaults(input, {}), { log: false });
  t.after(() => {
    gw.server.closeAllConnections();
    gw.server.close();
  });
  return { ...gw, url: await listen(gw.server) };
}

const ok: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};
const slow: http.RequestListener = (_req, res) => {
  setTimeout(() => {
    res.writeHead(200);
    res.end("{}");
  }, 300);
};
const chat = (url: string, model: string, key?: string) =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model }),
  });
const overview = (url: string, key = "admin-secret-key") =>
  fetch(`${url}/admin/api/overview`, { headers: { authorization: `Bearer ${key}` } });

test("admin is disabled unless adminKey is configured", async (t) => {
  const up = await upstream(t, ok);
  const gw = await gateway(t, { providers: [{ name: "p", baseUrl: up.url }] });
  assert.equal((await fetch(`${gw.url}/admin`)).status, 404);
  assert.equal((await overview(gw.url)).status, 404);
});

test("admin serves the page and guards the data behind the admin key", async (t) => {
  const up = await upstream(t, ok);
  const gw = await gateway(t, { adminKey: "admin-secret-key", providers: [{ name: "p", baseUrl: up.url }] });

  const page = await fetch(`${gw.url}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /llm-gateway/);

  assert.equal((await fetch(`${gw.url}/admin/api/overview`)).status, 401);
  assert.equal((await overview(gw.url, "nope")).status, 401);
  assert.equal((await overview(gw.url)).status, 200);
});

test("overview counts requests, failures, models and clients without leaking secrets", async (t) => {
  const bad = await upstream(t, (_req, res) => {
    res.writeHead(400);
    res.end("{}");
  });
  const okUp = await upstream(t, ok);
  const gw = await gateway(t, {
    adminKey: "admin-secret-key",
    clientKeys: [{ name: "team-a", key: "client-secret-key-1234" }],
    providers: [
      { name: "good", baseUrl: okUp.url, keys: ["sk-upstream-secret-9876"], models: ["m-ok"] },
      { name: "bad", baseUrl: bad.url, models: ["m-bad"] },
    ],
  });

  await chat(gw.url, "m-ok", "client-secret-key-1234");
  await chat(gw.url, "m-ok", "client-secret-key-1234");
  await chat(gw.url, "m-bad", "client-secret-key-1234"); // upstream 400 passes through, counts as failed
  await chat(gw.url, "unknown-model", "client-secret-key-1234"); // 503, unrouted
  await chat(gw.url, "m-ok", "wrong"); // 401

  const text = await (await overview(gw.url)).text();
  for (const secret of ["sk-upstream-secret-9876", "client-secret-key-1234", "admin-secret-key"]) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
  const d = JSON.parse(text);
  assert.equal(d.totals.total, 5);
  assert.equal(d.totals.failed, 3);
  assert.deepEqual(d.models.find((m: { name: string }) => m.name === "m-ok"), { name: "m-ok", total: 2, failed: 0 });
  assert.ok(d.models.some((m: { name: string }) => m.name === "(unrouted)"));
  assert.deepEqual(d.clients[0], { name: "team-a", key: "••••1234", ratePerMinute: 60, total: 4, failed: 2 });
  assert.equal(d.providers.find((p: { name: string }) => p.name === "good").keys[0].key, "••••9876");
  assert.equal(d.providers.find((p: { name: string }) => p.name === "good").served, 2);
  assert.equal(d.recent[0].status, 401);
  assert.equal(d.series.at(-1).ok + d.series.at(-1).failed, 5);
});

test("locks the admin API after repeated wrong keys, even for the right key", async (t) => {
  const up = await upstream(t, ok);
  const gw = await gateway(t, { adminKey: "admin-secret-key", providers: [{ name: "p", baseUrl: up.url }] });
  for (let i = 0; i < 10; i++) assert.equal((await overview(gw.url, "guess" + i)).status, 401);
  assert.equal((await overview(gw.url, "guess-11")).status, 429);
  assert.equal((await overview(gw.url)).status, 429);
});

test("does not call the upstream for a client that left while queued", async (t) => {
  const up = await upstream(t, slow);
  const gw = await gateway(t, { providers: [{ name: "p", baseUrl: up.url, maxConcurrent: 1, queueSize: 4 }] });

  const first = chat(gw.url, "m");
  await new Promise((r) => setTimeout(r, 50));
  const ctrl = new AbortController();
  const queued = fetch(`${gw.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
    signal: ctrl.signal,
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  ctrl.abort();
  await queued;
  assert.equal((await first).status, 200);
  await new Promise((r) => setTimeout(r, 100)); // let the freed slot reach the abandoned waiter
  assert.equal(up.hits(), 1);
  assert.equal(gw.stats.aborted, 1);
});
