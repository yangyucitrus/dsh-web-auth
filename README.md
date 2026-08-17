# @yangyucitrus/dsh-web-auth

Shared-secret request gate for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web server. Every HTTP request must present one of the configured keys **before route dispatch** — the browser UI, static assets, and the `/api` RPC bridge are all gated. Unauthenticated requests receive `401` with a `WWW-Authenticate: Bearer realm="dsh"` challenge.

## Why

The built-in browser-trust fence (`client-connection/api-request-trust`) is a Host/Origin defense against DNS rebinding and cross-site requests — it is **not** an authentication layer. The harness webserver deliberately refuses to bind `0.0.0.0`, so the supported way to serve the UI beyond loopback is a reverse proxy in front. This plugin is the auth layer for that deployment shape: put TLS in front, then gate with a shared key.

## Install

Via the harness plugin mechanism (pnpm-forwarding):

```sh
dsh plugin --profile web add github:yangyucitrus/dsh-web-auth
```

Or in any Cordis composition, add the row to a patch layer:

```yaml
- id: web-auth
  name: '@yangyucitrus/dsh-web-auth'
  config:
    keys:
      - 'replace-with-a-long-random-secret'
    header: x-dsh-key          # optional, default x-dsh-key
    excludePaths:              # optional, default empty
      - /healthz
```

Requests pass when they carry one of the keys in either form:

```text
Authorization: Bearer <key>
X-Dsh-Key: <key>
```

## Requirement: the webserver interceptor seam

This plugin authenticates at the HTTP layer through `ctx.webServer.registerInterceptor`. **Shipped versions of `@deepseek-ai/dsh-host-webserver` do not provide that seam** (it is a small upstream gap — the official webserver has no per-request extension point). Use a harness build that carries the seam. If the seam is missing, the plugin refuses to load with a clear error instead of failing at request time.

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `keys` | `string[]` | *(required)* | Shared secrets that unlock the UI. At least one is required. |
| `header` | `string` | `x-dsh-key` | Custom header that carries the key. |
| `excludePaths` | `string[]` | `[]` | Path prefixes exempt from the gate (exact or prefix match). |

## How it works

The plugin registers a request interceptor on the `webServer` seam. Interceptors run before route dispatch on every HTTP request; returning `false` short-circuits the request with the interceptor's own response (here, a `401`). Registration is an effect — when the owning fiber unloads, the gate is removed and unauthenticated access returns.

## Security notes

- Keys are compared with a plain array lookup. Keep them long and random (e.g. `openssl rand -hex 32`).
- Use TLS in front. This plugin does not encrypt anything; it only gates.
- If you expose the UI publicly, also consider rate limiting at your reverse proxy to blunt brute force.

## Development

The REAL-composition test boots a test-only `cordis.yml` through the vendored Loader and asserts the user-visible HTTP surface. Because the seam lives in a harness build, devDependencies link against a local `dsh-fork` checkout (clone it as a sibling directory):

```sh
git clone https://github.com/deepseek-ai/deepseek-harness dsh-fork
cd dsh-fork && pnpm install
# apply the interceptor seam (registerInterceptor) to packages/host/webserver
cd ../dsh-web-auth && pnpm install && pnpm test
```

## Known Limitations and Deferred Work

- No per-key scoping or revocation beyond editing the config.
- No built-in rate limiting (deferred to the reverse proxy).
- Key comparison is not constant-time; acceptable for low-traffic personal deployments, revisit before high-volume use.