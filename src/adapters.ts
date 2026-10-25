import { randomUUID } from "node:crypto";

/**
 * Adapters let a provider speak something other than the OpenAI chat API.
 * The client always talks OpenAI; an adapter describes, as data, how to build the provider's
 * request from the OpenAI one and how to read the provider's answer back into OpenAI shape.
 * Anthropic and Gemini are just adapters shipped as presets.
 */
export type Format = "openai" | "anthropic" | "gemini" | "custom";
export const FORMATS: Format[] = ["openai", "anthropic", "gemini", "custom"];

export type AdapterConfig = {
  /** Appended to the provider's baseUrl. May contain {{variables}} (URL-encoded). */
  path?: string;
  /** Where the key goes. Empty scheme sends the bare key; default is `Authorization: Bearer <key>`. */
  auth?: { header?: string; scheme?: string };
  /** Static extra headers, e.g. a version header. Never put secrets here, use the provider's keys. */
  headers?: Record<string, string>;
  defaults?: { max_tokens?: number };
  /** JSON body template. A string that is exactly "{{name}}" is replaced by the value itself (any type). */
  request?: unknown;
  response?: {
    text?: string;
    finishReason?: string;
    finishMap?: Record<string, string>;
    promptTokens?: string;
    completionTokens?: string;
    id?: string;
    model?: string;
    /** Where the provider puts its error message, for readable errors. */
    error?: string;
  };
  /** Server-sent events mapping. Omit (or null) if the API cannot stream: replies are then streamed in one piece. */
  streaming?: { path?: string; text?: string; finishReason?: string } | null;
};

export const PRESETS: Record<"anthropic" | "gemini", AdapterConfig> = {
  anthropic: {
    path: "/messages",
    auth: { header: "x-api-key", scheme: "" },
    headers: { "anthropic-version": "2023-06-01" },
    defaults: { max_tokens: 4096 },
    request: {
      model: "{{model}}",
      max_tokens: "{{max_tokens}}",
      system: "{{system}}",
      messages: "{{messages}}",
      temperature: "{{temperature}}",
      top_p: "{{top_p}}",
      stop_sequences: "{{stop}}",
      stream: "{{stream}}",
    },
    response: {
      id: "id",
      model: "model",
      text: "content[*].text",
      finishReason: "stop_reason",
      promptTokens: "usage.input_tokens",
      completionTokens: "usage.output_tokens",
      error: "error.message",
    },
    streaming: { text: "delta.text", finishReason: "delta.stop_reason" },
  },
  gemini: {
    path: "/models/{{model}}:generateContent",
    auth: { header: "x-goog-api-key", scheme: "" },
    request: {
      systemInstruction: { parts: [{ text: "{{system}}" }] },
      contents: "{{gemini_contents}}",
      generationConfig: { maxOutputTokens: "{{max_tokens}}", temperature: "{{temperature}}", topP: "{{top_p}}", stopSequences: "{{stop}}" },
    },
    response: {
      text: "candidates[0].content.parts[*].text",
      finishReason: "candidates[0].finishReason",
      promptTokens: "usageMetadata.promptTokenCount",
      completionTokens: "usageMetadata.candidatesTokenCount",
      error: "error.message",
    },
    streaming: { path: "/models/{{model}}:streamGenerateContent?alt=sse", text: "candidates[0].content.parts[*].text", finishReason: "candidates[0].finishReason" },
  },
};

/** What the "custom" format starts from in the dashboard. */
export const CUSTOM_STARTER: AdapterConfig = {
  path: "/generate",
  auth: { header: "authorization", scheme: "Bearer" },
  defaults: { max_tokens: 1024 },
  request: { model: "{{model}}", prompt: "{{transcript}}", max_tokens: "{{max_tokens}}", temperature: "{{temperature}}" },
  response: { text: "output.text", finishReason: "output.finish_reason", promptTokens: "usage.input", completionTokens: "usage.output", error: "error.message" },
};

/** Variables a request template can use. `undefined` ones (not sent by the client) drop their key from the body. */
export const VARIABLES: Record<string, string> = {
  model: "Model name the client asked for",
  stream: "true when the reply is streamed from the provider, else false",
  max_tokens: "max_tokens or max_completion_tokens from the client, else defaults.max_tokens",
  temperature: "Sampling temperature, if sent",
  top_p: "Nucleus sampling, if sent",
  stop: "List of stop sequences, if sent",
  system: "All system/developer messages joined, if any",
  messages: "User and assistant turns as [{role, content}] (text), without system messages",
  all_messages: "Every message including system, as [{role, content}] (text)",
  gemini_contents: "Turns as [{role: user|model, parts: [{text}]}]",
  last_user: "Text of the last user message",
  transcript: "The whole conversation as one text, one 'role: text' line per message",
};

export type Vars = Record<string, unknown>;

/* ---------- resolving and validating ---------- */

export function resolveAdapter(format: Format | undefined, override?: AdapterConfig | null): AdapterConfig | null {
  if (!format || format === "openai") return null;
  const base: AdapterConfig = format === "custom" ? {} : PRESETS[format];
  const o = override ?? {};
  return {
    path: o.path ?? base.path,
    auth: { header: "authorization", scheme: "Bearer", ...base.auth, ...o.auth },
    headers: { ...base.headers, ...o.headers },
    defaults: { ...base.defaults, ...o.defaults },
    request: o.request ?? base.request,
    response: { ...base.response, ...o.response },
    streaming: o.streaming === null ? undefined : o.streaming || base.streaming ? { ...base.streaming, ...o.streaming } : undefined,
  };
}

const PATH_RE = /^(?:[\w$-]+|\[\d+\]|\[\*\])(?:\.[\w$-]+|\[\d+\]|\[\*\])*$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "accept-encoding"]);
const PLACEHOLDER = /\{\{\s*([\s\S]*?)\s*\}\}/g;

export type AdapterIssue = { path: string; message: string };

function placeholderIssues(value: unknown, at: string, out: AdapterIssue[]) {
  if (typeof value === "string") {
    for (const m of value.matchAll(PLACEHOLDER)) {
      if (!/^\w+$/.test(m[1]) || !(m[1] in VARIABLES)) out.push({ path: at, message: `Unknown variable {{${m[1]}}}. Available: ${Object.keys(VARIABLES).join(", ")}` });
    }
    if ((value.match(/\{\{/g) ?? []).length !== (value.match(PLACEHOLDER) ?? []).length) out.push({ path: at, message: "Unclosed {{ in a template string" });
  } else if (Array.isArray(value)) value.forEach((v) => placeholderIssues(v, at, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => placeholderIssues(v, at, out));
}

export function validateAdapter(spec: AdapterConfig | null): AdapterIssue[] {
  if (!spec) return [];
  const out: AdapterIssue[] = [];
  const need = (path: string, v: unknown, what: string) => {
    if (typeof v !== "string" || !PATH_RE.test(v)) out.push({ path, message: `${what} must be a path like a.b[0].c (use [*] to join every element)` });
  };
  const opt = (path: string, v: unknown, what: string) => v === undefined || v === "" || need(path, v, what);

  if (typeof spec.path !== "string" || !spec.path.startsWith("/") || spec.path.length > 300) out.push({ path: "path", message: "Path must start with / (it is added to the base URL)" });
  else placeholderIssues(spec.path, "path", out);
  const auth = spec.auth ?? {};
  if (typeof auth.header !== "string" || !/^[A-Za-z0-9-]{1,60}$/.test(auth.header) || FORBIDDEN_HEADERS.has(auth.header.toLowerCase())) out.push({ path: "auth.header", message: "Use a plain header name such as Authorization or x-api-key" });
  if (typeof auth.scheme !== "string" || auth.scheme.length > 30 || /[\r\n]/.test(auth.scheme)) out.push({ path: "auth.scheme", message: "Scheme is a short word like Bearer, or empty to send the bare key" });
  if (spec.headers && (typeof spec.headers !== "object" || Array.isArray(spec.headers))) out.push({ path: "headers", message: "Headers must be an object of name: value" });
  else
    for (const [k, v] of Object.entries(spec.headers ?? {})) {
      if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) out.push({ path: "headers", message: `Header name "${k}" is not allowed` });
      else if (typeof v !== "string" || v.length > 500 || /[\r\n]/.test(v)) out.push({ path: "headers", message: `Header "${k}" must be a short text value` });
    }
  const mt = spec.defaults?.max_tokens;
  if (mt !== undefined && !(Number.isInteger(mt) && mt >= 1 && mt <= 1_000_000)) out.push({ path: "defaults.max_tokens", message: "Enter a whole number between 1 and 1000000" });

  const req = spec.request;
  if (!req || typeof req !== "object") out.push({ path: "request", message: "The request body template must be a JSON object" });
  else if (JSON.stringify(req).length > 20_000) out.push({ path: "request", message: "Template is too large (20 KB max)" });
  else placeholderIssues(req, "request", out);

  const r = spec.response ?? {};
  need("response.text", r.text, "Reply text");
  for (const k of ["finishReason", "promptTokens", "completionTokens", "id", "model", "error"] as const) opt(`response.${k}`, r[k], k);
  if (r.finishMap !== undefined && (typeof r.finishMap !== "object" || r.finishMap === null || Object.values(r.finishMap).some((v) => typeof v !== "string"))) out.push({ path: "response.finishMap", message: "Finish map must be an object of provider value: OpenAI value" });
  if (spec.streaming) {
    need("streaming.text", spec.streaming.text, "Stream text");
    opt("streaming.finishReason", spec.streaming.finishReason, "finishReason");
    if (spec.streaming.path !== undefined && spec.streaming.path !== "") {
      if (typeof spec.streaming.path !== "string" || !spec.streaming.path.startsWith("/")) out.push({ path: "streaming.path", message: "Stream path must start with /" });
      else placeholderIssues(spec.streaming.path, "streaming.path", out);
    }
  }
  return out;
}

/* ---------- templates and paths ---------- */

const UNDEF = Symbol("undef");

function render(node: unknown, vars: Vars): unknown {
  if (typeof node === "string") {
    const whole = /^\{\{\s*(\w+)\s*\}\}$/.exec(node);
    if (whole) return vars[whole[1]] === undefined ? UNDEF : vars[whole[1]];
    return node.replace(PLACEHOLDER, (_, n: string) => {
      const v = vars[n.trim()];
      return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(node)) {
    const out = node.map((x) => render(x, vars)).filter((x) => x !== UNDEF);
    return node.length && !out.length ? UNDEF : out;
  }
  if (node && typeof node === "object") {
    const entries = Object.entries(node).map(([k, v]) => [k, render(v, vars)] as const).filter(([, v]) => v !== UNDEF);
    return entries.length === 0 && Object.keys(node).length > 0 ? UNDEF : Object.fromEntries(entries);
  }
  return node;
}

function renderPath(path: string, vars: Vars) {
  return path.replace(PLACEHOLDER, (_, n: string) => {
    const v = vars[n.trim()];
    return v === undefined ? "" : encodeURIComponent(String(v));
  });
}

function walk(node: unknown, tokens: string[]): unknown[] {
  if (!tokens.length) return [node];
  const [t, ...rest] = tokens;
  if (node === null || typeof node !== "object") return [];
  if (t === "*") return Array.isArray(node) ? node.flatMap((n) => walk(n, rest)) : [];
  if (Array.isArray(node)) return /^\d+$/.test(t) ? walk(node[+t], rest) : [];
  return Object.hasOwn(node, t) ? walk((node as Record<string, unknown>)[t], rest) : [];
}
const tokens = (path: string) => [...path.matchAll(/\[(\d+|\*)\]|([\w$-]+)/g)].map((m) => m[1] ?? m[2]);

/** Value at a path like `a.b[0].c`; `[*]` collects every element. Returns the strings joined, or undefined. */
export function getText(obj: unknown, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const strings = walk(obj, tokens(path)).filter((v): v is string => typeof v === "string");
  return strings.length ? strings.join("") : undefined;
}
function getNumber(obj: unknown, path: string | undefined): number | undefined {
  if (!path) return undefined;
  return walk(obj, tokens(path)).find((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/* ---------- OpenAI request -> variables ---------- */

type Msg = { role: string; content: unknown };
const SYSTEM = new Set(["system", "developer"]);

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : null));
  return parts.every((p) => p !== null) ? parts.join("") : null;
}

/** Adapters only handle plain text chat. Anything else (tools, images, ...) must go to an OpenAI-compatible provider. */
export function isTextChat(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || !b.messages.length) return false;
  if (b.tools || b.functions || b.tool_choice || b.function_call) return false;
  if (typeof b.n === "number" && b.n > 1) return false;
  const rf = b.response_format as { type?: string } | undefined;
  if (rf && rf.type && rf.type !== "text") return false;
  return (b.messages as Msg[]).every((m) => m && ["system", "developer", "user", "assistant"].includes(m.role) && textOf(m.content) !== null);
}

export function toVars(body: Record<string, unknown>, spec: AdapterConfig, stream: boolean): Vars {
  const all = (body.messages as Msg[]).map((m) => ({ role: SYSTEM.has(m.role) ? "system" : m.role, content: textOf(m.content) as string }));
  const turns = all.filter((m) => m.role !== "system");
  const system = all.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    model: body.model,
    stream,
    max_tokens: num(body.max_tokens) ?? num(body.max_completion_tokens) ?? spec.defaults?.max_tokens,
    temperature: num(body.temperature),
    top_p: num(body.top_p),
    stop,
    system: system || undefined,
    messages: turns,
    all_messages: all,
    gemini_contents: turns.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    last_user: [...turns].reverse().find((m) => m.role === "user")?.content,
    transcript: all.map((m) => `${m.role}: ${m.content}`).join("\n"),
  };
}

export type Upstream = { url: string; headers: Record<string, string>; body: string; streaming: boolean };

export function buildUpstream(spec: AdapterConfig, body: Record<string, unknown>, baseUrl: string, key: string | null, wantStream: boolean): Upstream {
  const streaming = wantStream && !!spec.streaming;
  const vars = toVars(body, spec, streaming);
  const rendered = render(spec.request, vars);
  const auth = spec.auth ?? {};
  return {
    url: baseUrl + renderPath((streaming && spec.streaming?.path) || spec.path || "/", vars),
    headers: {
      "content-type": "application/json",
      accept: streaming ? "text/event-stream" : "application/json",
      ...spec.headers,
      ...(key ? { [auth.header || "authorization"]: auth.scheme ? `${auth.scheme} ${key}` : key } : {}),
    },
    body: JSON.stringify(rendered === UNDEF ? {} : rendered),
    streaming,
  };
}

/* ---------- provider answer -> OpenAI ---------- */

const DEFAULT_FINISH: Record<string, string> = {
  stop: "stop", end_turn: "stop", stop_sequence: "stop", STOP: "stop", COMPLETE: "stop", length: "length", max_tokens: "length", MAX_TOKENS: "length", SAFETY: "content_filter", content_filter: "content_filter",
};
const mapFinish = (spec: AdapterConfig, v: string | undefined) => (v === undefined ? undefined : (spec.response?.finishMap?.[v] ?? DEFAULT_FINISH[v] ?? "stop"));

export function toOpenAI(spec: AdapterConfig, json: unknown, model: string) {
  const r = spec.response ?? {};
  const text = getText(json, r.text);
  if (text === undefined) return null;
  const prompt = getNumber(json, r.promptTokens), completion = getNumber(json, r.completionTokens);
  return {
    id: getText(json, r.id) ?? `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: getText(json, r.model) ?? model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: mapFinish(spec, getText(json, r.finishReason)) ?? "stop" }],
    ...(prompt !== undefined || completion !== undefined
      ? { usage: { prompt_tokens: prompt ?? 0, completion_tokens: completion ?? 0, total_tokens: (prompt ?? 0) + (completion ?? 0) } }
      : {}),
  };
}

/** A readable message out of a provider error body (JSON path if configured, else a short excerpt). */
export function errorMessage(spec: AdapterConfig, raw: string, status: number): string {
  let msg: string | undefined;
  try {
    msg = getText(JSON.parse(raw), spec.response?.error);
  } catch {}
  return msg ?? (raw.trim().slice(0, 300) || `Upstream answered ${status}`);
}

/* ---------- streaming ---------- */

function sseChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** Turns the provider's SSE stream into OpenAI chat.completion.chunk events. */
export function translateStream(spec: AdapterConfig, model: string): TransformStream<Uint8Array, Uint8Array> {
  const s = spec.streaming ?? {};
  const dec = new TextDecoder(), enc = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
  let buf = "", started = false, finish: string | undefined;
  const send = (ctl: TransformStreamDefaultController<Uint8Array>, delta: Record<string, unknown>, fin: string | null = null) => ctl.enqueue(enc.encode(sseChunk(id, created, model, delta, fin)));
  const start = (ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (!started) send(ctl, { role: "assistant", content: "" });
    started = true;
  };
  const line = (raw: string, ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (!raw.startsWith("data:")) return;
    const data = raw.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const text = getText(json, s.text);
    if (text) {
      start(ctl);
      send(ctl, { content: text });
    }
    const f = getText(json, s.finishReason);
    if (f) finish = mapFinish(spec, f);
  };
  return new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i).trimEnd(), ctl);
        buf = buf.slice(i + 1);
      }
    },
    flush(ctl) {
      if (buf.trim()) line(buf.trim(), ctl);
      start(ctl);
      send(ctl, {}, finish ?? "stop");
      ctl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  });
}

/** For adapters that cannot stream: send a finished completion as a stream of three events. */
export function completionAsSse(c: NonNullable<ReturnType<typeof toOpenAI>>): string {
  const { id, created, model } = c, ch = c.choices[0];
  return sseChunk(id, created, model, { role: "assistant", content: "" }, null) + sseChunk(id, created, model, { content: ch.message.content }, null) + sseChunk(id, created, model, {}, ch.finish_reason) + "data: [DONE]\n\n";
}
