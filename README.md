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
- Writes JSON access logs (no secrets, failures included) and exposes Prometheus metrics.
- Serves an [admin dashboard](#admin-dashboard) at `/admin`: live traffic, failures, latency and request history, plus editable settings (providers, keys, clients, balancer) that apply without a restart.

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

To manage the gateway from the browser, set `GATEWAY_ADMIN_KEY` in `.env` and open `http://localhost:8080/admin` (see [Admin dashboard](#admin-dashboard)).

## Configuration

See [`config.example.json`](config.example.json). Any key can be written as `"env:NAME"` to read it from the environment.

| Field | Default | Meaning |
|---|---|---|
| `port` | `8080` | Listen port |
| `adminKey` | unset | Key for the `/admin` dashboard. If unset, the dashboard is disabled. Only editable in the file or environment |
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
| `GET /admin` | none | Dashboard page (contains no data) |
| `/admin/api/*` | admin key | JSON API behind the dashboard, see [Admin API](#admin-api) |

`/healthz` and `/metrics` contain no secrets but are not authenticated, so keep them on an internal network.

Metrics: `gateway_upstream_requests_total{provider,status}`, `gateway_retries_total{provider,reason}`, `gateway_rejected_total{reason}`, and the gauges `gateway_provider_inflight`, `gateway_provider_queued` and `gateway_provider_breaker_open`.

## Admin dashboard

A built-in web panel to watch the gateway and change its settings without touching files or restarting. It is one HTML page served by the gateway itself (no build step, no external assets), with a dark and a light theme, and it works on phones.

![Overview: traffic chart, success rate, latency, top models, provider health and recent errors](docs/images/overview.png)

### Turn it on

1. Pick an admin key and put it in your config (the example config already does this):

   ```json
   { "adminKey": "env:GATEWAY_ADMIN_KEY" }
   ```

   ```bash
   # .env
   GATEWAY_ADMIN_KEY=a-long-random-string
   ```

2. Start the gateway and open **http://localhost:8080/admin**.
3. Sign in with the admin key. It lives in the tab's `sessionStorage` and is sent as a Bearer token; closing the tab signs you out.

Without `adminKey` the dashboard is disabled (`/admin` answers 404).

### Tour

Use the sidebar, or press `1` to `5`.

**Overview** shows total, failed and aborted requests, success rate, p50/p95 latency, a traffic chart (15 min, 30 min or 1 h; hover a bar for the exact numbers), the most used models, provider health and the latest errors. Click a model to see its requests. A banner appears when a circuit breaker is open, every key of a provider is cooling down, a queue is almost full, or client authentication is off.

**Providers** shows, per provider: load, queue, breaker state, how many requests it served, and each upstream key (masked) with its usage and cooldown. A routing matrix shows which provider can serve which model. If a provider is unhealthy, *Reset breaker & cooldowns* puts it back in rotation right away.

![Providers: load, queue, upstream keys with usage and cooldown, and the model routing matrix](docs/images/providers.png)

**Clients** lists your gateway keys with their rate limit, usage and failure rate. Click a client to see only its requests.

**Requests** keeps the last 200 requests in memory. Search by model, client, error or request ID, filter by status, model, provider or client, sort any column, and export the current view to CSV. Click a row for the details: status, latency, number of attempts, which provider answered, and the error.

| List | Detail |
|---|---|
| ![Requests table with filters](docs/images/requests.png) | ![Request detail panel](docs/images/request-detail.png) |

### Change settings

**Settings** edits the same `config.json` the gateway started with and applies the result to the running process. Nothing is saved until you press **Save changes**; a bar at the bottom tells you there is a pending draft, and *Discard* throws it away.

**Providers.** Add one from a preset (OpenAI, OpenRouter, Groq, Together AI, Mistral, DeepSeek, Ollama, LM Studio) or a custom URL, then edit its name, base URL, weight, concurrency, queue size and models. *Test connection* calls `GET {baseUrl}/models` with the provider's own key and offers to fill in the model list for you.

![Settings, providers tab: name, weight, URL, concurrency, models and upstream keys](docs/images/settings-providers.png)

![Adding a provider from a preset](docs/images/settings-add-provider.png)

**Upstream keys.** Add, replace or remove keys of a provider. Paste the key, or type `env:NAME` to read it from an environment variable; references are kept exactly as written, so a key that came from `.env` stays out of `config.json`. Existing keys are only ever shown as their last four characters.

**Clients.** Add or remove gateway keys and set each one's rate limit. A key can be generated for you (shown once, right after saving, with a copy button), rotated, or typed in by hand.

![Settings, clients tab](docs/images/settings-clients.png)

**Balancer.** Sliders set each provider's weight and show the traffic share you get when all providers are equally busy. Below are the failover knobs: max attempts, upstream and queue timeouts, circuit breaker threshold and cooldown, and the default key cooldown.

![Settings, balancer tab: weights with traffic share, timeouts and circuit breaker](docs/images/settings-balancer.png)

How saving works:

- The server validates the whole draft first and reports each problem next to its field (duplicate names, bad URLs, a client key that is too short, an `env:` variable that is not set, numbers out of range). If anything is wrong, nothing is written.
- On success the previous file is copied to `config.json.bak`, the new one is written, and the gateway switches to it immediately. Requests already in flight finish normally.
- A provider whose settings did not change keeps its live state (breaker, key cooldowns, queue). A provider you edited starts fresh.
- Removing every client key turns authentication off, so the panel asks you to confirm.

**General** shows the version, uptime, memory and port, and has a button to reset the statistics.

### Good to know

- **The config file must be writable.** With Docker, `docker-compose.yml` mounts `config.json` read-write; the container runs as the `node` user, so run `chmod a+rw config.json` (or `chown 1000 config.json`) once. If the file cannot be written, Settings stays read-only and tells you why.
- **Keys typed into the panel are saved in plain text** in `config.json`, like any key you would paste there. Use `env:NAME` to keep secrets in the environment instead. Keep `config.json` and `config.json.bak` out of version control (they are in `.gitignore`).
- **The admin key and the port cannot be changed from the panel**, so a typo can never lock you out. Edit the file or the environment and restart.
- **Statistics live in memory** and reset when the gateway restarts. Requests that the client abandons, or streams cut after they started, are counted as `499 aborted` and not as failures.
- **Brute force protection:** ten wrong admin keys within a minute lock the admin API for a minute.
- **Use HTTPS or a private network.** The admin key travels in a request header, like your client keys do. The page sends a strict Content-Security-Policy and renders every value as text.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `1` to `5` | Overview, Providers, Clients, Requests, Settings |
| `/` | Search requests |
| `r` | Refresh now |
| `t` | Toggle light and dark theme |
| `Esc` | Close the detail panel or leave the search box |

The refresh interval (5 s, 15 s, 30 s or paused), theme and chart range are remembered in your browser.

![Light theme](docs/images/overview-light.png)

<p align="center"><img src="docs/images/mobile.png" alt="Overview on a phone" width="320"></p>

### Admin API

The dashboard is a client of a small JSON API. Everything below needs `Authorization: Bearer <adminKey>`.

| Endpoint | |
|---|---|
| `GET /admin/api/overview` | Totals, series, models, providers, clients, recent requests |
| `GET /admin/api/config` | Editable config; secrets masked |
| `PUT /admin/api/config` | Validate and apply a draft. `422` with `{ error: { issues: [{ path, message }] } }` if invalid |
| `POST /admin/api/test` | Probe `GET {baseUrl}/models` for a provider (`{ provider }`) or typed values (`{ baseUrl, key }`) |
| `POST /admin/api/providers/:name/reset` | Close the breaker and clear key cooldowns |
| `POST /admin/api/stats/reset` | Clear statistics |

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
- Breakers, key cooldowns, queues, rate limits and dashboard statistics live in memory, so they are per process. With several replicas each one enforces its own limits, has its own statistics, and edits made in one dashboard do not reach the others.
- Limits count requests, not tokens.
- Only OpenAI-compatible upstreams are supported.

## Tests

```bash
npm test
npm run typecheck
```

The tests start fake upstream servers in-process, so no API keys are needed. They cover failover, the circuit breaker, key rotation, auth, rate limiting, queueing and load shedding, streaming, client disconnects, oversized bodies, model routing and metrics, plus the admin dashboard: statistics, access control and lockout, config validation, hot reload, secret masking and the `env:` references that must survive a save.

## License

MIT
