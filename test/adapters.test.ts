import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PRESETS, buildUpstream, completionAsSse, getText, isTextChat, resolveAdapter, toOpenAI, translateStream, validateAdapter, type AdapterConfig } from "../src/adapters.ts";
import { withDefaults, type ConfigInput } from "../src/config.ts";
import { createGateway } from "../src/server.ts";

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: "m",
  messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: [{ type: "text", text: "Bye" }] }],
  ...extra,
});
const anthropic = () => resolveAdapter("anthropic")!;
const gemini = () => resolveAdapter("gemini")!;

/* ---------- units ---------- */

test("reads values by path, joining [*] and ignoring anything unsafe", () => {
  const json = { a: { b: [{ c: "x" }, { c: "y" }, { d: 1 }] }, n: 5 };
  assert.equal(getText(json, "a.b[0].c"), "x");
  assert.equal(getText(json, "a.b[*].c"), "xy");
  assert.equal(getText(json, "a.missing[0]"), undefined);
  assert.equal(getText(json, "n"), undefined, "numbers are not text");
  assert.equal(getText(json, "constructor.name"), undefined);
  assert.equal(getText(json, "__proto__.x"), undefined);
});

test("builds an Anthropic request from an OpenAI one", () => {
  const up = buildUpstream(anthropic(), chatBody({ temperature: 0.2, stop: "END" }), "https://api.anthropic.com/v1", "sk-ant-1", false);
  assert.equal(up.url, "https://api.anthropic.com/v1/messages");
  assert.equal(up.headers["x-api-key"], "sk-ant-1");
  assert.equal(up.headers["anthropic-version"], "2023-06-01");
  assert.equal(up.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(up.body), {
    model: "m",
    max_tokens: 4096,
    system: "Be brief.",
    messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: "Bye" }],
    temperature: 0.2,
    stop_sequences: ["END"],
    stream: false,
  });
});

test("leaves out what the client did not send", () => {
  const body = JSON.parse(buildUpstream(anthropic(), { model: "m", messages: [{ role: "user", content: "Hi" }], max_tokens: 10 }, "http://x", null, false).body);
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "stream"]);
});

test("builds a Gemini request: model in the path, roles renamed, empty sections dropped", () => {
  const up = buildUpstream(gemini(), chatBody(), "https://generativelanguage.googleapis.com/v1beta", "g-key", false);
  assert.equal(up.url, "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent");
  assert.equal(up.headers["x-goog-api-key"], "g-key");
  const body = JSON.parse(up.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Be brief." }] });
  assert.deepEqual(body.contents.map((c: { role: string }) => c.role), ["user", "model", "user"]);
  assert.equal(body.generationConfig, undefined, "all-undefined generationConfig is dropped");
  const s = buildUpstream(gemini(), { model: "a/b c", messages: [{ role: "user", content: "x" }], temperature: 0 }, "http://x", null, true);
  assert.equal(s.url, "http://x/models/a%2Fb%20c:streamGenerateContent?alt=sse");
  assert.equal(s.streaming, true);
  assert.equal(JSON.parse(s.body).systemInstruction, undefined);
  assert.deepEqual(JSON.parse(s.body).generationConfig, { temperature: 0 });
});

test("falls back to a plain request when the adapter cannot stream", () => {
  const spec: AdapterConfig = { ...anthropic(), streaming: undefined };
  const up = buildUpstream(spec, chatBody({ stream: true }), "http://x", null, true);
  assert.equal(up.streaming, false);
  assert.equal(JSON.parse(up.body).stream, false);
});

test("maps a provider answer to an OpenAI completion", () => {
  const out = toOpenAI(anthropic(), { id: "msg_1", model: "claude-x", content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }], stop_reason: "max_tokens", usage: { input_tokens: 7, output_tokens: 3 } }, "m")!;
  assert.equal(out.choices[0].message.content, "Hello");
  assert.equal(out.choices[0].finish_reason, "length");
  assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.equal(out.id, "msg_1");
  assert.equal(toOpenAI(anthropic(), { content: [] }, "m"), null, "no text found");
});

test("translates a provider event stream, even when a line is split across chunks", async () => {
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join("");
  const bytes = new TextEncoder().encode(events);
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, 120)); // cuts a line in half
      c.enqueue(bytes.slice(120));
      c.close();
    },
  });
  const text = await new Response(src.pipeThrough(translateStream(anthropic(), "m"))).text();
  const chunks = text.split("\n\n").filter(Boolean);
  assert.equal(chunks.at(-1), "data: [DONE]");
  const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c.slice(6)));
  assert.equal(parsed[0].choices[0].delta.role, "assistant");
  assert.equal(parsed.map((p) => p.choices[0].delta.content ?? "").join(""), "Hello");
  assert.equal(parsed.at(-1).choices[0].finish_reason, "stop");
  assert.ok(parsed.every((p) => p.object === "chat.completion.chunk" && p.model === "m"));
});

test("can stream a finished completion in one piece", () => {
  const sse = completionAsSse(toOpenAI(anthropic(), { content: [{ text: "ok" }], stop_reason: "end_turn" }, "m")!);
  assert.match(sse, /"content":"ok"/);
  assert.match(sse, /"finish_reason":"stop"/);
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
});

test("only plain text chat is translatable", () => {
  assert.equal(isTextChat(chatBody()), true);
  assert.equal(isTextChat(chatBody({ tools: [{}] })), false);
  assert.equal(isTextChat(chatBody({ n: 2 })), false);
  assert.equal(isTextChat({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }), false);
  assert.equal(isTextChat({ model: "m", messages: [{ role: "tool", content: "x" }] }), false);
  assert.equal(isTextChat({ model: "m" }), false);
});

test("validates custom adapters and explains each problem", () => {
  assert.deepEqual(validateAdapter(anthropic()), []);
  assert.deepEqual(validateAdapter(gemini()), []);
  const bad = resolveAdapter("custom", {
    path: "generate",
    auth: { header: "Content-Length", scheme: "Bearer" },
    headers: { "X-Ok": "1", Host: "evil" },
    request: { prompt: "{{nope}} and {{model", n: "{{ max_tokens }}" },
    response: { text: "a..b", finishReason: "ok.path" },
    streaming: { text: "" },
  });
  const paths = validateAdapter(bad).map((i) => i.path);
  for (const p of ["path", "auth.header", "headers", "request", "response.text", "streaming.text"]) assert.ok(paths.includes(p), `expected issue for ${p}, got ${paths}`);
  assert.equal(validateAdapter(resolveAdapter("custom", { path: "/x", request: { a: "{{model}}" }, response: { text: "out" } })).length, 0);
});

test("presets can be overridden piece by piece", () => {
  const spec = resolveAdapter("anthropic", { headers: { "anthropic-beta": "x" }, defaults: { max_tokens: 99 }, streaming: null })!;
  assert.deepEqual(spec.headers, { "anthropic-version": "2023-06-01", "anthropic-beta": "x" });
  assert.equal(spec.defaults?.max_tokens, 99);
  assert.equal(spec.streaming, undefined);
  assert.equal(spec.response?.text, PRESETS.anthropic.response?.text);
  assert.equal(resolveAdapter("openai"), null);
});

/* ---------- through the gateway ---------- */

type After = { after: (fn: () => void) => void };
async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function upstream(t: After, handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const seen: { url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: await listen(server), seen };
}
const json = (code: number, obj: unknown) => (_req: http.IncomingMessage, _b: string, res: http.ServerResponse) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
async function gateway(t: After, input: ConfigInput) {
  const gw = createGateway(withDefaults(input, {}), { log: false });
  t.after(() => {
    gw.server.closeAllConnections();
    gw.server.close();
  });
  return { ...gw, url: await listen(gw.server) };
}
const chat = (url: string, extra: Record<string, unknown> = {}) =>
  fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "Hi" }], ...extra }) });
const claudeAnswer = { id: "msg_9", model: "claude-x", content: [{ type: "text", text: "Hello there" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } };

test("an Anthropic provider answers an OpenAI client", async (t) => {
  const up = await upstream(t, json(200, claudeAnswer));
  const gw = await gateway(t, { providers: [{ name: "claude", baseUrl: up.url + "/v1", format: "anthropic", keys: ["sk-ant-test"], models: ["claude-x"] }] });
  const res = await chat(gw.url, { max_tokens: 50 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gateway-provider"), "claude");
  const out = (await res.json()) as { object: string; choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number } };
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "Hello there");
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.equal(out.usage.total_tokens, 6);
  assert.equal(up.seen[0].url, "/v1/messages");
  assert.equal(up.seen[0].headers["x-api-key"], "sk-ant-test");
  assert.equal(JSON.parse(up.seen[0].body).max_tokens, 50);
});

test("streams a translated reply", async (t) => {
  const up = await upstream(t, (_req, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const w of ["Hel", "lo"]) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: w } })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
  });
  const gw = await gateway(t, { providers: [{ name: "claude", baseUrl: up.url + "/v1", format: "anthropic", models: ["claude-x"] }] });
  const res = await chat(gw.url, { stream: true });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  const content = text.split("\n\n").filter((c) => c.startsWith("data: {")).map((c) => JSON.parse(c.slice(6)).choices[0].delta.content ?? "").join("");
  assert.equal(content, "Hello");
  assert.equal(JSON.parse(up.seen[0].body).stream, true);
});

test("a stream request still works when the adapter cannot stream", async (t) => {
  const up = await upstream(t, json(200, { reply: "whole answer" }));
  const gw = await gateway(t, {
    providers: [{ name: "odd", baseUrl: up.url, format: "custom", models: ["claude-x"], adapter: { path: "/talk", request: { q: "{{last_user}}", s: "{{stream}}" }, response: { text: "reply" } } }],
  });
  const text = await (await chat(gw.url, { stream: true })).text();
  assert.match(text, /"content":"whole answer"/);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  assert.deepEqual(JSON.parse(up.seen[0].body), { q: "Hi", s: false });
});

test("a custom API works with its own auth header, path and field names", async (t) => {
  const up = await upstream(t, json(200, { result: { items: [{ out: "A" }, { out: "B" }], why: "LIMIT" }, tokens: { in: 3, out: 1 } }));
  const gw = await gateway(t, {
    providers: [{
      name: "acme", baseUrl: up.url, format: "custom", keys: ["secret-1"], models: ["claude-x"],
      adapter: {
        path: "/v2/{{model}}/complete", auth: { header: "X-Acme-Key", scheme: "" }, headers: { "X-Client": "gw" }, defaults: { max_tokens: 33 },
        request: { input: { text: "{{transcript}}", limit: "{{max_tokens}}" }, creative: "{{temperature}}" },
        response: { text: "result.items[*].out", finishReason: "result.why", finishMap: { LIMIT: "length" }, promptTokens: "tokens.in", completionTokens: "tokens.out" },
      },
    }],
  });
  const out = (await (await chat(gw.url)).json()) as { choices: { message: { content: string }; finish_reason: string }[]; usage: { prompt_tokens: number } };
  assert.equal(out.choices[0].message.content, "AB");
  assert.equal(out.choices[0].finish_reason, "length");
  assert.equal(out.usage.prompt_tokens, 3);
  assert.equal(up.seen[0].url, "/v2/claude-x/complete");
  assert.equal(up.seen[0].headers["x-acme-key"], "secret-1");
  assert.equal(up.seen[0].headers["x-client"], "gw");
  assert.deepEqual(JSON.parse(up.seen[0].body), { input: { text: "user: Hi", limit: 33 } });
});

test("fails over from a translated provider to an OpenAI one", async (t) => {
  const bad = await upstream(t, json(500, {}));
  const good = await upstream(t, json(200, { choices: [{ message: { content: "from openai" } }] }));
  const gw = await gateway(t, {
    providers: [
      { name: "claude", baseUrl: bad.url, format: "anthropic", weight: 10, models: ["claude-x"] },
      { name: "openai", baseUrl: good.url, models: ["claude-x"] },
    ],
  });
  const res = await chat(gw.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gateway-provider"), "openai");
});

test("keeps tool calls and other endpoints away from translated providers", async (t) => {
  const claude = await upstream(t, json(200, claudeAnswer));
  const openai = await upstream(t, json(200, { ok: true }));
  const gw = await gateway(t, {
    providers: [
      { name: "claude", baseUrl: claude.url, format: "anthropic", weight: 100, models: ["claude-x"] },
      { name: "openai", baseUrl: openai.url, models: ["claude-x"] },
    ],
  });
  assert.equal((await chat(gw.url, { tools: [{ type: "function", function: { name: "f" } }] })).headers.get("x-gateway-provider"), "openai");
  const emb = await fetch(`${gw.url}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-x", input: "x" }) });
  assert.equal(emb.headers.get("x-gateway-provider"), "openai");
  assert.equal(claude.seen.length, 0);

  const only = await gateway(t, { providers: [{ name: "claude", baseUrl: claude.url, format: "anthropic", models: ["claude-x"] }] });
  const res = await chat(only.url, { tools: [{}] });
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /plain text chat only/);
});

test("shows a translated provider's client error in OpenAI shape, and fails over on an unreadable answer", async (t) => {
  const four = await upstream(t, json(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }));
  const gw = await gateway(t, { providers: [{ name: "claude", baseUrl: four.url, format: "anthropic", models: ["claude-x"] }] });
  const res = await chat(gw.url);
  assert.equal(res.status, 400);
  const err = (await res.json()) as { error: { message: string; type: string } };
  assert.equal(err.error.type, "upstream_error");
  assert.match(err.error.message, /claude: max_tokens too large/);

  const weird = await upstream(t, json(200, { surprise: true }));
  const gw2 = await gateway(t, { providers: [{ name: "claude", baseUrl: weird.url, format: "anthropic", models: ["claude-x"] }] });
  const bad = await chat(gw2.url);
  assert.equal(bad.status, 502);
  assert.match(((await bad.json()) as { error: { message: string } }).error.message, /response mapping/);
});

test("rejects a broken adapter when the gateway starts", () => {
  assert.throws(() => createGateway(withDefaults({ providers: [{ name: "x", baseUrl: "http://x", format: "custom", adapter: { path: "no-slash" } }] }, {}), { log: false }), /adapter\.path/);
});
