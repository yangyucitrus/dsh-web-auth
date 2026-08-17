/**
 * @deepseek-ai/dsh-web-auth — shared-secret gate for the Harness web server.
 *
 * Mounts a request interceptor on the webServer seam: every HTTP request must
 * present one of the configured shared keys (via `Authorization: Bearer <key>`
 * or the custom header) before route dispatch. This is an authentication layer
 * for deployments that front the browser UI over the network — the built-in
 * browser-trust fence (api-request-trust) is a Host/Origin defense, not an
 * auth layer, and the webserver deliberately refuses to bind 0.0.0.0.
 *
 * Static assets and the SPA shell are gated too: without a key the browser
 * receives 401 before any route or fallback handler runs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      registerInterceptor(
        interceptor: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>,
      ): () => void
    }
  }
}

/** Gateway config. */
export interface Config {
  /** Shared secrets that unlock the UI. At least one is required. */
  keys: string[]
  /**
   * Header that carries the key. Defaults to `x-dsh-key`; the standard
   * `Authorization: Bearer <key>` form is always accepted too.
   */
  header: string
  /**
   * Path prefixes exempt from the gate (e.g. `/healthz`). Exact pathnames or
   * prefix segments; a prefix matches the path and anything below it.
   */
  excludePaths: string[]
}

/** Normalized bearer/key candidates from one request, or empty when absent. */
function keyCandidates(
  req: IncomingMessage,
  header: string,
): string[] {
  const candidates: string[] = []
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match !== null && match[1] !== undefined) candidates.push(match[1])
  }
  const custom = req.headers[header.toLowerCase()]
  if (typeof custom === 'string') candidates.push(custom)
  return candidates
}

/** Whether a path is exempted by an exclude list (exact or prefix match). */
function isExcluded(rawPath: string, excludePaths: readonly string[]): boolean {
  return excludePaths.some((exclude) => {
    const prefix = exclude.endsWith('/') ? exclude.slice(0, -1) : exclude
    return rawPath === prefix || rawPath.startsWith(`${prefix}/`)
  })
}

/**
 * Mount the shared-key interceptor. Registration is an effect: disposing the
 * owning fiber removes the gate and restores unauthenticated access.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (typeof ctx.webServer.registerInterceptor !== 'function') {
    throw new Error(
      'web-auth requires the webserver request-interceptor seam '
      + '(ctx.webServer.registerInterceptor), which shipped versions of '
      + '@deepseek-ai/dsh-host-webserver do not provide. Use a harness build '
      + 'that carries the seam (see README).',
    )
  }
  const { keys, header, excludePaths } = config
  ctx.effect(() => ctx.webServer.registerInterceptor(async (req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (isExcluded(rawPath, excludePaths)) return true
    const candidates = keyCandidates(req, header)
    if (candidates.some((candidate) => keys.includes(candidate))) return true
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Bearer realm="dsh"',
    })
    res.end('unauthorized: a valid dsh key is required')
    return false
  }), 'web-auth: request gate')
}

export const name = 'web-auth'
export const inject = ['webServer']
export const Config: z<Config> = z.object({
  keys: z.array(String).min(1).required(),
  header: z.string().default('x-dsh-key'),
  excludePaths: z.array(String).default([]),
})
