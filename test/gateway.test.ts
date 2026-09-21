import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { withDefaults, type ConfigInput } from "../src/config.ts";
import { createGateway } from "../src/server.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Fake LLM upstream. Records the Authorization header of every hit. */
async function mockUpstream(t: { after: (fn: () => void) => void }, handler: Handler) {
  const auths: string[] = [];
  const server = http.createServer((req, res) => {
    auths.push(req.headers.authorization ?? "");
    req.resume();
    handler(req, res);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: await listen(server), auths };
}

const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
};
const status =
  (code: number, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(code, headers);
    res.end("{}");
  };

async function startGateway(t: { after: (fn: () => void) => void }, input: ConfigInput) {
  const config = withDefaults(input, {});
  const gw = createGateway(config, { log: false });
  t.after(() => {
    gw.server.closeAllConnections();
    gw.server.close();
  });
  return { ...gw, url: await listen(gw.server) };
}

const chat = (url: string, headers: Record<string, string> = {}, model = "m") =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });

test("falls back to the next provider when one returns 5xx", async (t) => {
  const bad = await mockUpstream(t, status(500));
  const good = await mockUpstream(t, ok);
  const gw = await startGateway(t, {
    providers: [
      { name: "bad", baseUrl: bad.url, weight: 10 },
      { name: "good", baseUrl: good.url },
    ],
  });

  const res = await chat(gw.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gateway-provider"), "good");
});

test("circuit breaker stops sending traffic to a failing provider", async (t) => {
  const bad = await mockUpstream(t, status(500));
  const good = await mockUpstream(t, ok);
  const gw = await startGateway(t, {
    breaker: { failures: 3, cooldownMs: 60_000 },
    providers: [
      { name: "bad", baseUrl: bad.url },
      { name: "good", baseUrl: good.url },
    ],
  });

  for (let i = 0; i < 10; i++) assert.equal((await chat(gw.url)).status, 200);
  assert.ok(bad.auths.length <= 3, `bad provider was hit ${bad.auths.length} times`);
});

test("rotates to the next key when an upstream key is rate limited", async (t) => {
  const up = await mockUpstream(t, (req, res) =>
    req.headers.authorization === "Bearer k1" ? status(429, { "retry-after": "60" })(req, res) : ok(req, res),
  );
  const gw = await startGateway(t, { providers: [{ name: "p", baseUrl: up.url, keys: ["k1", "k2"] }] });

  assert.equal((await chat(gw.url)).status, 200);
  assert.deepEqual(up.auths, ["Bearer k1", "Bearer k2"]);

  assert.equal((await chat(gw.url)).status, 200);
  assert.equal(up.auths.at(-1), "Bearer k2", "k1 stays in cooldown");
});

test("returns 502 when every provider fails", async (t) => {
  const bad = await mockUpstream(t, status(503));
  const gw = await startGateway(t, { providers: [{ name: "bad", baseUrl: bad.url }] });
  assert.equal((await chat(gw.url)).status, 502);
});

test("passes upstream 4xx errors through without retrying", async (t) => {
  const up = await mockUpstream(t, status(400));
  const gw = await startGateway(t, { providers: [{ name: "p", baseUrl: up.url, keys: ["k1", "k2"] }] });

  assert.equal((await chat(gw.url)).status, 400);
  assert.equal(up.auths.length, 1, "a client error must not trigger key rotation or retries");
});

test("requires a valid client key when clientKeys are configured", async (t) => {
  const up = await mockUpstream(t, ok);
  const gw = await startGateway(t, {
    clientKeys: [{ name: "team", key: "secret" }],
    providers: [{ name: "p", baseUrl: up.url }],
  });

  assert.equal((await chat(gw.url)).status, 401);
  assert.equal((await chat(gw.url, { authorization: "Bearer nope" })).status, 401);
  assert.equal((await chat(gw.url, { authorization: "Bearer secret" })).status, 200);
});

test("enforces the per-client rate limit", async (t) => {
  const up = await mockUpstream(t, ok);
  const gw = await startGateway(t, {
    clientKeys: [{ name: "team", key: "secret", ratePerMinute: 2 }],
    providers: [{ name: "p", baseUrl: up.url }],
  });
  const h = { authorization: "Bearer secret" };

  assert.equal((await chat(gw.url, h)).status, 200);
  assert.equal((await chat(gw.url, h)).status, 200);
  const limited = await chat(gw.url, h);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("sheds load with 503 when the queue is full", async (t) => {
  const slow = await mockUpstream(t, (req, res) => setTimeout(() => ok(req, res), 300));
  const gw = await startGateway(t, {
    providers: [{ name: "slow", baseUrl: slow.url, maxConcurrent: 1, queueSize: 0 }],
  });

  const statuses = (await Promise.all([chat(gw.url), chat(gw.url)])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 503]);
});

test("queues requests instead of rejecting while there is queue room", async (t) => {
  const slow = await mockUpstream(t, (req, res) => setTimeout(() => ok(req, res), 100));
  const gw = await startGateway(t, {
    providers: [{ name: "slow", baseUrl: slow.url, maxConcurrent: 1, queueSize: 4 }],
  });

  const statuses = (await Promise.all([chat(gw.url), chat(gw.url), chat(gw.url)])).map((r) => r.status);
  assert.deepEqual(statuses, [200, 200, 200]);
});

test("streams responses through", async (t) => {
  const up = await mockUpstream(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => res.end("data: two\n\n"), 30);
  });
  const gw = await startGateway(t, { providers: [{ name: "p", baseUrl: up.url }] });

  const res = await chat(gw.url);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), "data: one\n\ndata: two\n\n");
});

test("only routes a model to providers that serve it", async (t) => {
  const up = await mockUpstream(t, ok);
  const gw = await startGateway(t, { providers: [{ name: "p", baseUrl: up.url, models: ["gpt-x"] }] });

  assert.equal((await chat(gw.url, {}, "gpt-x")).status, 200);
  assert.equal((await chat(gw.url, {}, "other")).status, 503);
});

test("lists configured models and exposes health and metrics", async (t) => {
  const up = await mockUpstream(t, ok);
  const gw = await startGateway(t, { providers: [{ name: "p", baseUrl: up.url, models: ["gpt-x"] }] });

  const models = await (await fetch(`${gw.url}/v1/models`)).json();
  assert.equal(models.data[0].id, "gpt-x");

  await chat(gw.url, {}, "gpt-x");
  const health = await (await fetch(`${gw.url}/healthz`)).json();
  assert.equal(health.status, "ok");

  const metrics = await (await fetch(`${gw.url}/metrics`)).text();
  assert.match(metrics, /gateway_upstream_requests_total\{provider="p",status="200"\} 1/);
  assert.match(metrics, /gateway_provider_breaker_open\{provider="p"\} 0/);
});

test("rejects malformed requests", async (t) => {
  const up = await mockUpstream(t, ok);
  const gw = await startGateway(t, { providers: [{ name: "p", baseUrl: up.url }] });

  const notJson = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", body: "nope" });
  assert.equal(notJson.status, 400);
  const noModel = await fetch(`${gw.url}/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(noModel.status, 400);
});
