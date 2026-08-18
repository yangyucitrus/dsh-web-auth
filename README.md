# @yangyucitrus/dsh-web-auth

Shared-secret request gate plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web server. **Fully self-contained**: it works on the official harness as-is — no fork, no core patch, no upstream seam. Every HTTP request and WebSocket upgrade must present one of the configured keys before the original handler chain runs.

Unauthorized browsers receive a **login page styled after the harness web UI** (deepseek-blue brand, bluish neutrals, dark mode follows the system preference); non-browser clients receive a plain `401` with a `WWW-Authenticate: Bearer realm="dsh"` challenge. Authenticating on the login page mints a session cookie, so static assets, SSE, and WebSockets all pass automatically — no header juggling in the browser.

## Why

The built-in browser-trust fence (`client-connection/api-request-trust`) is a Host/Origin defense against DNS rebinding and cross-site requests — it is **not** an authentication layer. The harness webserver deliberately refuses to bind `0.0.0.0`, so the supported way to serve the UI beyond loopback is a reverse proxy in front. This plugin is the auth layer for that deployment shape: put TLS in front, then gate with a shared key.

## Install

Via the harness plugin mechanism (pnpm-forwarding):

```sh
dsh plugin --profile web add github:yangyucitrus/dsh-web-auth
```

Then enable it in the profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: web-auth
      name: '@yangyucitrus/dsh-web-auth'
      config:
        keys:
          - 'replace-with-a-long-random-secret'
        header: x-dsh-key          # optional, default x-dsh-key
        authPath: /__dsh_auth      # optional, default /__dsh_auth
        cookieName: dsh_key        # optional, default dsh_key
        cookieMaxAgeSeconds: 604800  # optional, default 7 days
        excludePaths:              # optional, default empty
          - /healthz
        title: DeepSeek Harness    # optional, login page branding
```

## How requests are gated

The plugin unwraps the live `node:http` server owned by `ctx.webServer` and wraps its `request` and `upgrade` listeners in an auth gate. Authorized requests (any of these):

```text
Authorization: Bearer <key>
X-Dsh-Key: <key>
Cookie: dsh_key=<key>        # minted by the login page
```

flow through to the original handler chain unchanged (routes, static files, SSE, WebSocket upgrades). Everything else:

- `Accept: text/html` → the login page (`200`, no-store)
- other clients → `401` + `WWW-Authenticate: Bearer realm="dsh"`
- WebSocket upgrades → socket rejected `401`

Logging in (`POST /__dsh_auth` with `key=…`) verifies the key and sets `dsh_key=<key>; Path=/; SameSite=Strict; Max-Age=…`. **Sign out** on the login page sends `DELETE /__dsh_auth`, which clears the cookie. Registration is an effect — unloading the plugin restores the original listeners exactly.

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `keys` | `string[]` | *(required)* | Shared secrets that unlock the UI. At least one is required. |
| `header` | `string` | `x-dsh-key` | Custom header that carries the key. |
| `authPath` | `string` | `/__dsh_auth` | Login page path and session login/logout endpoint. |
| `cookieName` | `string` | `dsh_key` | Session cookie name. |
| `cookieMaxAgeSeconds` | `number` | `604800` | Session lifetime (60 … 31536000). |
| `excludePaths` | `string[]` | `[]` | Path prefixes exempt from the gate (exact or prefix match). |
| `title` | `string` | `DeepSeek Harness` | Login page branding title. |

## Security notes

- Keys are compared with a plain array lookup. Keep them long and random (e.g. `openssl rand -hex 32`).
- The session cookie is **not** `HttpOnly` (the server must read it) and is not `Secure` by default — the plugin assumes TLS termination happens in the reverse proxy in front. Put TLS in front. This plugin does not encrypt anything; it only gates.
- If you expose the UI publicly, also consider rate limiting at your reverse proxy to blunt brute force.
- The gate wraps the server's listeners via a structural read of the WebServer service. It targets the official harness layout; a future harness refactor that hides the server differently would fail loudly at load (clear error), not quietly.

## Development

The REAL-composition test boots a test-only `cordis.yml` through the vendored Loader with the **official npm** `@deepseek-ai/dsh-host-webserver` and asserts the user-visible HTTP surface — no harness fork required:

```sh
pnpm install && pnpm test
```

## Known Limitations and Deferred Work

- No per-key scoping or revocation beyond editing the config.
- No built-in rate limiting (deferred to the reverse proxy).
- Key comparison is not constant-time; acceptable for low-traffic personal deployments, revisit before high-volume use.