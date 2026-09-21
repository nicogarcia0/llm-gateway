# llm-gateway

A small proxy that sits between your apps and one or more LLM providers. It speaks the OpenAI API, so existing clients only need a different base URL.

It handles the parts that get repetitive once several services call LLMs: spreading load across providers, falling back when one fails, pooling API keys, queueing, and rate limiting per client.

```
client A ─┐                                       ┌─▶ provider 1 (keys k1, k2)
client B ─┼─▶ llm-gateway ─────────────────────────┼─▶ provider 2 (key k3)
client C ─┘   auth, rate limit, route, queue      └─▶ local Ollama (no key)
              retry, key rotation
```

No runtime dependencies. Node 22.18+ runs the TypeScript sources directly.

## What it does

- Proxies `POST /v1/*` (chat completions, embeddings, ...) to any OpenAI-compatible API, and passes streaming responses through. `GET /v1/models` lists the models from the config.
- Picks the least-loaded provider that serves the requested model. Load is in-flight requests relative to `maxConcurrent`, divided by `weight`.
- Retries on the next provider after a network error, a timeout or a 5xx. A provider that keeps failing is skipped for a cooldown period (circuit breaker). Client errors (4xx) are returned as they are.
- Keeps several upstream keys per provider and rotates through them. A key that gets a 429 (honouring `Retry-After`) or a 401/403 is put on cooldown and the next key is used.
- Limits concurrency per provider with a bounded wait queue. When the queue is full or the wait times out, it answers 503 with `Retry-After`.
- Authenticates clients with their own keys and rate limits each one (token bucket). Upstream keys are never exposed to clients.
- Writes JSON access logs (no secrets) and exposes Prometheus metrics.

## Running it

```bash
npm install
cp config.example.json config.json
cp .env.example .env        # keys referenced as "env:NAME" in config.json
npm start
```

`npm start` reads `config.json` (or the file in `CONFIG_PATH`) and loads `.env` if it exists. With Docker, `docker compose up --build` mounts `config.json` and loads `.env` for you.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY_TEAM_A" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<gateway key>")
```

Responses carry `x-gateway-provider` (which provider answered) and `x-request-id`.

## Configuration

See [`config.example.json`](config.example.json). Any key can be written as `"env:NAME"` to read it from the environment.

| Field | Default | Meaning |
|---|---|---|
| `port` | `8080` | Listen port |
| `clientKeys[]` | `[]` | `{ name, key, ratePerMinute }`. If empty, authentication is off and a warning is logged |
| `providers[].name`, `baseUrl` | required | Any OpenAI-compatible API (OpenAI, Ollama, vLLM, LiteLLM, ...) |
| `providers[].keys` | `[]` | Upstream keys. Empty means no `Authorization` header |
| `providers[].weight` | `1` | Higher weight gets proportionally more traffic |
| `providers[].maxConcurrent`, `queueSize` | `8`, `32` | Concurrent requests allowed and queue length |
| `providers[].models` | `[]` | Models served. Empty means any |
| `upstreamTimeoutMs` | `60000` | Time to wait for the upstream response headers |
| `queueTimeoutMs` | `10000` | Longest a request waits in a queue |
| `maxAttempts` | `3` | Upstream attempts per request |
| `breaker.failures`, `breaker.cooldownMs` | `3`, `15000` | Consecutive failures that open the breaker, and for how long |
| `keyCooldownMs` | `30000` | Cooldown for a rate-limited key when the upstream sends no `Retry-After` |

## Endpoints

| Endpoint | Auth | |
|---|---|---|
| `POST /v1/*` | client key | Proxied to a provider |
| `GET /v1/models` | client key | Models from the config |
| `GET /healthz` | none | Breaker state, in-flight and queued requests per provider |
| `GET /metrics` | none | Prometheus metrics |

`/healthz` and `/metrics` contain no secrets but are not authenticated, so keep them on an internal network.

Metrics: `gateway_upstream_requests_total{provider,status}`, `gateway_retries_total{provider,reason}`, `gateway_rejected_total{reason}`, and the gauges `gateway_provider_inflight`, `gateway_provider_queued` and `gateway_provider_breaker_open`.

## Request flow

1. Check the client key and its rate limit (401 / 429).
2. Read `model` from the body and list the providers that serve it and have a closed breaker, least loaded first.
3. Wait for a concurrency slot on the first one. If its queue is full, go to the next provider.
4. Take the next available key and call the upstream.
   - 429, 401 or 403: put that key on cooldown and try the next key.
   - Network error, timeout or 5xx: count a failure against the provider and try the next one.
   - Anything else: send it back to the client.
5. If nothing worked, answer 503 when every provider was at capacity and 502 otherwise.

## Limitations

- A request can only fail over before the response starts. Once bytes are streaming to the client, a failure upstream ends the stream.
- Breakers, key cooldowns, queues and rate limits live in memory, so they are per process. With several replicas each one enforces its own limits.
- Limits count requests, not tokens.
- Only OpenAI-compatible upstreams are supported.

## Tests

```bash
npm test
npm run typecheck
```

The tests start fake upstream servers in-process, so no API keys are needed. They cover failover, the circuit breaker, key rotation, auth, rate limiting, queueing and load shedding, streaming, client disconnects, oversized bodies, model routing and metrics.

## License

MIT
