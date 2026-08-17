/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver plus web-auth rows, and every
 * assertion observes the user-visible HTTP surface (gate blocks, keys pass,
 * excludes bypass, disposer restores pass-through).
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
async function loadComposition(port = 0): Promise<Context> {
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
  return context
}

/** GET one path against the running server; returns status plus a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 120) }
}

describe('real Loader composition with web-auth', () => {
  it('gates every request until a configured key is presented', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    const port = server.port

    // Register a probe route so a successful key pass is observable.
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('OPEN') } })

    // No key: 401 with the realm challenge, before any route handler runs.
    const denied = await request(port, '/probe')
    expect(denied.status).toBe(401)
    expect(denied.body).toContain('unauthorized')

    // Wrong key: 401 too.
    expect((await request(port, '/probe', {
      headers: { authorization: 'Bearer wrong-key' },
    })).status).toBe(401)

    // Custom header key passes.
    expect(await request(port, '/probe', {
      headers: { 'x-dsh-key': 'secret-one' },
    })).toMatchObject({ status: 200, body: 'OPEN' })

    // Standard Authorization: Bearer key passes.
    expect(await request(port, '/probe', {
      headers: { authorization: 'Bearer secret-two' },
    })).toMatchObject({ status: 200, body: 'OPEN' })

    // Excluded path bypasses the gate entirely (no key needed).
    server.register({ kind: 'prefix', path: '/healthz', handler: (_req, res) => { res.writeHead(200); res.end('OK') } })
    expect(await request(port, '/healthz')).toMatchObject({ status: 200, body: 'OK' })
    // A path under an excluded prefix also bypasses.
    expect(await request(port, '/healthz/deep')).toMatchObject({ status: 200, body: 'OK' })
  })
})
