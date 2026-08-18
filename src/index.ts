/**
 * @yangyucitrus/dsh-web-auth — shared-secret request gate for the DeepSeek
 * Harness web server.
 *
 * Self-contained: mounts an auth gate over the live node:http server owned by
 * `ctx.webServer` (structural un-wrap, no harness seam required). Every HTTP
 * request and WebSocket upgrade must present one of the configured keys — via
 * `Authorization: Bearer`, a custom header, or a session cookie minted by the
 * login page — before the original handler chain runs. Unauthorized browser
 * requests receive a login page styled after the harness web UI; non-browser
 * clients receive a plain 401 with a Bearer challenge.
 *
 * Registration is an effect: disposing the owning fiber restores the original
 * listeners and unauthenticated access returns.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import {
  hijackServer,
  unwrapServer,
} from './server-hijack.ts'
import {
  makeRequestGate,
  makeUpgradeGate,
  type AuthConfig,
} from './auth.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
}

/** Gateway config. */
export interface Config extends AuthConfig {}

/**
 * Mount the shared-key gate on the live web server. The webServer service
 * must be active (its listener already bound); the gate wraps the underlying
 * node:http request and upgrade listeners and restores them on disposal.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const server = unwrapServer(ctx.webServer)
  if (server === undefined) {
    throw new Error(
      'web-auth could not unwrap the live node:http server from ctx.webServer. '
      + 'The @deepseek-ai/dsh-host-webserver version in this composition may '
      + 'store the server under an unexpected shape; file an issue with the '
      + 'harness version if this persists.',
    )
  }
  const requestGate = makeRequestGate(config)
  const upgradeGate = makeUpgradeGate(config)
  ctx.effect(() => hijackServer(server, requestGate, upgradeGate), 'web-auth: request gate')
}

export const name = 'web-auth'
export const inject = ['webServer']
export const Config: z<Config> = z.object({
  keys: z.array(String).min(1).required(),
  header: z.string().default('x-dsh-key'),
  authPath: z.string().default('/__dsh_auth'),
  cookieName: z.string().default('dsh_key'),
  cookieMaxAgeSeconds: z.natural().min(60).max(31536000).default(604800),
  excludePaths: z.array(String).default([]),
  title: z.string().default('DeepSeek Harness'),
})