# ai-gateway

A small, self-hosted, **OpenAI-compatible gateway** that sits in front of one or more LLM providers and handles the operational side of running AI in production: load balancing, failover, request queues, per-client rate limits and upstream key pooling.

Point any OpenAI SDK at it by changing the base URL. Zero runtime dependencies, about 500 lines of TypeScript.

```
                        ┌──────────────────────────────────────────┐
  client A ──┐          │                ai-gateway                │
  client B ──┼─ HTTP ──▶│ auth → rate limit → route → queue → call │──▶ provider 1 (keys k1,k2)
  client C ──┘          │            ▲            │                │──▶ provider 2 (keys k3)
                        │   circuit breaker   key rotation         │──▶ local Ollama (no key)
                        └──────────────┬───────────────────────────┘
                                       └── /healthz  /metrics (Prometheus)
```

## Why

Once several products or teams use LLMs, the same problems repeat: API keys scattered across services, no protection when a provider rate-limits or goes down, no way to cap one noisy client, and no visibility. This gateway centralises that in one place.

## Features

- **OpenAI-compatible**: proxies `POST /v1/*` (chat completions, embeddings, …) and serves `GET /v1/models`. Streaming (SSE) is passed through.
- **Load balancing**: sends each request to the least-loaded eligible provider (in-flight requests relative to capacity, normalised by a configurable weight).
- **Failover**: on network errors, timeouts or 5xx it retries on the next provider. Client errors (4xx) are returned as-is and never retried.
- **Circuit breaker**: a provider that keeps failing is taken out of rotation for a cooldown period, then probed again.
- **Key pooling and rotation**: several upstream keys per provider, used round-robin. A key that gets `429` (respecting `Retry-After`) or `401/403` is put in cooldown and the next key is used.
- **Bounded queues and load shedding**: each provider has a concurrency limit and a wait queue. When the queue is full or the wait times out, the gateway answers `503` with `Retry-After` instead of piling up work.
- **Per-client keys and rate limits**: clients authenticate with their own gateway keys (compared in constant time) and are limited with a token bucket. Upstream keys are never exposed to clients.
- **Observability**: JSON access logs (no secrets), `GET /healthz`, and Prometheus metrics at `GET /metrics`.
- **Secrets from the environment**: any key in the config can be written as `"env:NAME"`.

## Quick start

Requires Node.js 22.18+ (it runs the TypeScript sources directly, no build step).

```bash
git clone <this repo> && cd ai-gateway
npm install
cp config.example.json config.json   # edit providers/models
cp .env.example .env                  # add your keys

# load .env however you prefer, then:
npm start
```

With Docker:

```bash
docker compose up --build
```

Use it like OpenAI:

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

The response includes an `x-gateway-provider` header telling you which provider served it, and an `x-request-id`.

## Configuration

See [`config.example.json`](config.example.json).

| Field | Default | Meaning |
|---|---|---|
| `port` | `8080` | Listen port |
| `clientKeys[]` | `[]` | `{ name, key, ratePerMinute }`. If empty, auth is disabled (a warning is logged) |
| `providers[].name` / `baseUrl` | required | Any OpenAI-compatible API (OpenAI, Ollama, vLLM, LiteLLM, …) |
| `providers[].keys` | `[]` | Upstream keys; empty means no auth header |
| `providers[].weight` | `1` | Higher weight receives proportionally more traffic |
| `providers[].maxConcurrent` / `queueSize` | `8` / `32` | Concurrency cap and wait-queue length |
| `providers[].models` | `[]` | Models served; empty means any |
| `upstreamTimeoutMs` | `60000` | Time to receive upstream response headers |
| `queueTimeoutMs` | `10000` | Max time a request waits in a queue |
| `maxAttempts` | `3` | Upstream attempts per request |
| `breaker.failures` / `cooldownMs` | `3` / `15000` | Consecutive failures that open the breaker, and how long it stays open |
| `keyCooldownMs` | `30000` | Default cooldown for a rate-limited key |

## Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `POST /v1/*` | client key | Proxied to a provider |
| `GET /v1/models` | client key | Models from the config |
| `GET /healthz` | none | Provider state (breaker, in-flight, queued) |
| `GET /metrics` | none | Prometheus metrics |

`/healthz` and `/metrics` are unauthenticated and contain no secrets; keep them on an internal network or behind your reverse proxy.

Metrics: `gateway_upstream_requests_total{provider,status}`, `gateway_retries_total{provider,reason}`, `gateway_rejected_total{reason}`, and gauges `gateway_provider_inflight`, `gateway_provider_queued`, `gateway_provider_breaker_open`.

## How a request flows

1. Authenticate the client and apply its rate limit (`401` / `429`).
2. Read the `model` from the body and pick providers that serve it and whose breaker is closed, least-loaded first.
3. For the first provider: wait for a concurrency slot (bounded queue). If the queue is full, move on to the next provider.
4. Take the next healthy key and call the upstream.
   - `429/401/403`: cool that key down and try the next key.
   - network error, timeout or `5xx`: record a failure (feeds the breaker) and try the next provider.
   - anything else: stream it back to the client.
5. If nothing worked: `503` if every provider was simply at capacity, otherwise `502`.

## Design notes and trade-offs

- **No framework, no runtime dependencies.** `node:http`, `fetch` and streams are enough, which keeps the attack surface and the image small.
- **Failover happens before the first byte.** Once the response starts streaming to the client it cannot be replayed on another provider, so mid-stream failures surface as a truncated stream.
- **State is in memory.** Breakers, cooldowns, queues and rate limits are per process. That is correct for a single instance; running several replicas would need shared state (for example Redis) for global rate limits.
- **Capacity is measured in concurrent requests**, not tokens. Token-aware limits are a natural next step.

## Development

```bash
npm test          # node:test with in-process mock upstreams (no keys needed)
npm run typecheck # tsc --noEmit
```

The tests cover failover, the circuit breaker, key rotation, auth, rate limiting, queueing and load shedding, streaming, model routing, metrics and malformed input.

## Roadmap

- Token-aware rate limits and per-client usage accounting
- Optional Redis backend for multi-replica deployments
- Native Anthropic/Gemini adapters (today: OpenAI-compatible upstreams)
- Request/response caching for identical prompts

## License

MIT
