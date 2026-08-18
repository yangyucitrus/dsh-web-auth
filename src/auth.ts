/**
 * Auth gate construction for @yangyucitrus/dsh-web-auth: shared-key and
 * cookie-session verification over plain requests and upgrades.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { renderLoginPage } from './login-page.ts'

/** Plugin configuration consumed by the gate builders. */
export interface AuthConfig {
  /** Shared secrets that unlock the UI. At least one is required. */
  keys: string[]
  /** Custom header that carries the key. */
  header: string
  /** Path that serves the login page and accepts session login/logout. */
  authPath: string
  /** Session cookie name. */
  cookieName: string
  /** Session lifetime in seconds. */
  cookieMaxAgeSeconds: number
  /** Path prefixes exempt from the gate (exact or prefix match). */
  excludePaths: string[]
  /** Login page branding title. */
  title: string
}

/** Normalized bearer/key candidates from one request: header, bearer, cookie. */
export function keyCandidates(
  req: IncomingMessage,
  header: string,
  cookieName: string,
): string[] {
  const candidates: string[] = []
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match !== null && match[1] !== undefined) candidates.push(match[1])
  }
  const custom = req.headers[header.toLowerCase()]
  if (typeof custom === 'string') candidates.push(custom)
  const cookie = parseCookie(req.headers.cookie)[cookieName]
  if (cookie !== undefined && cookie.length > 0) candidates.push(cookie)
  return candidates
}

/** Parse a Cookie header into a plain record (first occurrence wins). */
export function parseCookie(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name.length > 0 && out[name] === undefined) out[name] = value
  }
  return out
}

/** Serialize a Set-Cookie value for the session cookie. */
export function sessionCookie(
  cookieName: string,
  key: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${cookieName}=${encodeURIComponent(key)}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${String(maxAgeSeconds)}`,
    ...(secure ? ['Secure'] : []),
  ]
  return parts.join('; ')
}

/** Whether a path is exempted by an exclude list (exact or prefix match). */
export function isExcluded(rawPath: string, excludePaths: readonly string[]): boolean {
  return excludePaths.some((exclude) => {
    const prefix = exclude.endsWith('/') ? exclude.slice(0, -1) : exclude
    return rawPath === prefix || rawPath.startsWith(`${prefix}/`)
  })
}

/** Read a bounded form body (application/x-www-form-urlencoded) for the login POST. */
export async function readFormBody(req: IncomingMessage, limitBytes = 4096): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > limitBytes) throw new Error('auth form body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Whether the client asks for HTML (drives the login-page vs plain-401 choice). */
export function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

/** Build the plain-request gate. Returns true to allow; false means a response was written. */
export function makeRequestGate(config: AuthConfig): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { keys, header, authPath, cookieName, cookieMaxAgeSeconds, excludePaths, title } = config
  const secure = false // TLS termination usually happens in the reverse proxy; operator opts in via config later.
  return async (req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (isExcluded(rawPath, excludePaths)) return true
    if (rawPath === authPath) {
      await handleAuthRequest(req, res, config, secure)
      return false
    }
    const candidates = keyCandidates(req, header, cookieName)
    if (candidates.some((candidate) => keys.includes(candidate))) return true
    if (acceptsHtml(req)) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(renderLoginPage(title, authPath, cookieName))
      return false
    }
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Bearer realm="dsh"',
    })
    res.end('unauthorized: a valid dsh key is required')
    return false
  }
}

/** Build the upgrade gate: allow only when a key/cookie is present. */
export function makeUpgradeGate(config: AuthConfig): (req: IncomingMessage) => Promise<boolean> {
  const { keys, header, cookieName, excludePaths, authPath } = config
  return async (req) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (isExcluded(rawPath, excludePaths)) return true
    if (rawPath === authPath) return false
    const candidates = keyCandidates(req, header, cookieName)
    return candidates.some((candidate) => keys.includes(candidate))
  }
}

/** Serve the login endpoint: GET renders the page, POST logs in, DELETE logs out. */
async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AuthConfig,
  secure: boolean,
): Promise<void> {
  const { keys, authPath, cookieName, cookieMaxAgeSeconds, title } = config
  const method = req.method ?? 'GET'
  const referer = req.headers.referer ?? '/'
  if (method === 'GET' || method === 'HEAD') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(renderLoginPage(title, authPath, cookieName))
    return
  }
  if (method === 'POST') {
    const body = await readFormBody(req)
    const params = new URLSearchParams(body)
    const candidate = params.get('key') ?? ''
    if (candidate.length > 0 && keys.includes(candidate)) {
      res.writeHead(302, {
        location: safeRedirect(referer, authPath),
        'set-cookie': sessionCookie(cookieName, candidate, cookieMaxAgeSeconds, secure),
      })
      res.end()
      return
    }
    // Wrong key: re-render the login page with an error state.
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': `${cookieName}=; Path=/; Max-Age=0; SameSite=Strict`,
    })
    res.end(renderLoginPage(title, authPath, cookieName, 'Invalid key. Try again.'))
    return
  }
  if (method === 'DELETE') {
    res.writeHead(302, {
      location: safeRedirect(referer, authPath),
      'set-cookie': `${cookieName}=; Path=/; Max-Age=0; SameSite=Strict`,
    })
    res.end()
    return
  }
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('method not allowed')
}

/** Keep a redirect target same-origin: fall back to the auth path otherwise. */
export function safeRedirect(target: string, fallback: string): string {
  if (!target.startsWith('/') || target.startsWith('//')) return fallback
  return target
}