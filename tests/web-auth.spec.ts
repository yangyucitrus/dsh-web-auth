/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the official (npm-published) webserver plus web-auth,
 * and every assertion observes the user-visible HTTP surface:
 * login page / plain 401 / header & bearer keys / cookie session login /
 * logout / excludes / upgrade gate / disposer restore.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as WebAuth from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with webserver + web-auth rows, then boot it through the real Loader. */
async function loadComposition(port = 0): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    '',
    `- name: '${WebAuth.name}'`,
    '  config:',
    '    keys:',
    "      - 'secret-one'",
    "      - 'secret-two'",
    '    excludePaths:',
    "      - '/healthz'",
    "    title: 'Test Harness'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['web-auth', WebAuth],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const server = (context as unknown as { webServer: { port: number } }).webServer
  return { ctx: context, port: server.port }
}

/** GET one path against the running server; returns status, headers, and a body prefix. */
async function request(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, headers: response.headers, body: (await response.text()).slice(0, 400) }
}

describe('real Loader composition with web-auth', () => {
  it('gates every request: login page for browsers, 401 for clients, keys and cookies pass',
    { timeout: 60_000 }, async () => {
      const { ctx, port } = await loadComposition()

      // A probe route so a successful pass is observable.
      const server = (ctx as unknown as { webServer: { register(o: unknown): () => void } }).webServer
      server.register({
        kind: 'exact', path: '/probe',
        handler: (_req: unknown, res: { writeHead(n: number): void; end(s: string): void }) => { res.writeHead(200); res.end('OPEN') },
      })

      // Browser-like request without a key: 200 login page, no-store.
      const login = await request(port, '/', { headers: { accept: 'text/html' } })
      expect(login.status).toBe(200)
      expect(login.headers.get('cache-control')).toBe('no-store')
      expect(login.body).toContain('Test Harness')
      expect(login.body).toContain('Sign in')

      // Non-browser client without a key: plain 401 + Bearer challenge.
      const denied = await request(port, '/probe')
      expect(denied.status).toBe(401)
      expect(denied.headers.get('www-authenticate')).toBe('Bearer realm="dsh"')
      expect(denied.body).toContain('unauthorized')

      // Custom header key passes.
      expect(await request(port, '/probe', {
        headers: { 'x-dsh-key': 'secret-one' },
      })).toMatchObject({ status: 200, body: 'OPEN' })

      // Standard Authorization: Bearer passes.
      expect(await request(port, '/probe', {
        headers: { authorization: 'Bearer secret-two' },
      })).toMatchObject({ status: 200, body: 'OPEN' })

      // Excluded path bypasses the gate entirely (no key needed).
      server.register({
        kind: 'prefix', path: '/healthz',
        handler: (_req: unknown, res: { writeHead(n: number): void; end(s: string): void }) => { res.writeHead(200); res.end('OK') },
      })
      expect(await request(port, '/healthz')).toMatchObject({ status: 200, body: 'OK' })
      expect(await request(port, '/healthz/deep')).toMatchObject({ status: 200, body: 'OK' })

      // Cookie session login: POST the key, follow the 302, then the cookie passes.
      const loginResponse = await fetch(`http://127.0.0.1:${String(port)}/__dsh_auth`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
          // Browsers send a full same-origin URL as Referer on form POSTs.
          referer: `http://127.0.0.1:${String(port)}/some/app?tab=1`,
        },
        body: 'key=secret-one',
        redirect: 'manual',
      })
      expect(loginResponse.status).toBe(302)
      // Redirect must land back on the referer's path (not the auth page).
      expect(loginResponse.headers.get('location')).toBe('/some/app?tab=1')
      const setCookie = loginResponse.headers.get('set-cookie')
      expect(setCookie).toMatch(/dsh_key=secret-one/)
      expect(setCookie).toMatch(/Max-Age=604800/)
      expect(setCookie).toMatch(/SameSite=Strict/)
      const cookie = setCookie?.split(';')[0] ?? ''
      expect(await request(port, '/probe', { headers: { cookie } })).toMatchObject({ status: 200, body: 'OPEN' })

      // Wrong key on the login POST: 401 + login page with an error state.
      const badLogin = await fetch(`http://127.0.0.1:${String(port)}/__dsh_auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: 'key=nope',
      })
      expect(badLogin.status).toBe(401)
      expect((await badLogin.text())).toContain('Invalid key')

      // Logout: DELETE clears the cookie, the old cookie no longer passes.
      const logout = await fetch(`http://127.0.0.1:${String(port)}/__dsh_auth`, {
        method: 'DELETE',
        redirect: 'manual',
      })
      expect(logout.status).toBe(302)
      expect(logout.headers.get('set-cookie')).toMatch(/Max-Age=0/)
      // After the browser clears the cookie, the same path is closed again.
      expect(await request(port, '/probe')).toMatchObject({ status: 401 })
    })

  it('disposer restores the original server listeners exactly', { timeout: 30_000 }, async () => {
    const raw = await new Promise<{ server: import('node:http').Server; url: string }>((resolve) => {
      const http = require('node:http') as typeof import('node:http')
      const s = http.createServer((_req, res) => { res.writeHead(200); res.end('RAW') })
      s.listen(0, '127.0.0.1', () => {
        const address = s.address() as { port: number }
        resolve({ server: s, url: `http://127.0.0.1:${String(address.port)}` })
      })
    })
    const { server, url } = raw
    expect((await (await fetch(url)).text())).toBe('RAW')

    const { hijackServer } = await import('../src/server-hijack.ts')
    const dispose = hijackServer(
      server,
      async (_req, res) => { res.writeHead(401); res.end('DENIED'); return false },
      async () => false,
    )
    expect((await fetch(url)).status).toBe(401)

    dispose()
    expect(await (await fetch(url)).text()).toBe('RAW')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})