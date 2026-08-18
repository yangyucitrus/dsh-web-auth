/**
 * In-process HTTP listener hijack: wraps the node:http server owned by
 * `WebServer` so every request and upgrade passes the auth gate before the
 * original handler chain runs. The wrapper is a registration effect — dispose
 * restores the original listeners exactly.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Decide one plain request; when false the gate has already written the response. */
export type RequestGate = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/** Decide one WebSocket/SSE upgrade; false rejects the socket. */
export type UpgradeGate = (req: IncomingMessage) => Promise<boolean>

/**
 * Wrap the request and upgrade listeners of a live node:http server with
 * gates. Unauthorized upgrades are rejected on the socket; unauthorized
 * requests are denied by the gate itself (login page or plain 401).
 * @param server - the live server instance (unwrapped from the webServer service).
 * @param gate - decides plain requests; false means the gate wrote the response.
 * @param upgradeGate - decides upgrades; false rejects the socket.
 * @returns the disposer restoring the original listeners.
 */
export function hijackServer(
  server: Server,
  gate: RequestGate,
  upgradeGate: UpgradeGate,
): () => void {
  const requestListeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>
  const upgradeListeners = server.listeners('upgrade') as Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>
  server.removeAllListeners('request')
  server.removeAllListeners('upgrade')

  server.on('request', async (req, res) => {
    try {
      if (await gate(req, res)) {
        for (const listener of requestListeners) listener(req, res)
      }
    } catch (error) {
      // Contain per-request like the original handler chain does: never let
      // one bad request tear down the process.
      const message = error instanceof Error ? error : new Error(String(error))
      console.warn('[dsh-web-auth] request gate failed:', message)
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end()
    }
  })

  server.on('upgrade', async (req, socket, head) => {
    try {
      if (await upgradeGate(req)) {
        for (const listener of upgradeListeners) listener(req, socket, head)
        return
      }
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
    } catch (error) {
      const message = error instanceof Error ? error : new Error(String(error))
      console.warn('[dsh-web-auth] upgrade gate failed:', message)
      socket.destroy()
    }
  })

  return () => {
    server.removeAllListeners('request')
    server.removeAllListeners('upgrade')
    for (const listener of requestListeners) server.on('request', listener)
    for (const listener of upgradeListeners) server.on('upgrade', listener)
  }
}

/**
 * Unwrap the live node:http server from a WebServer service instance. The
 * field is TypeScript-private (a plain runtime property), so this is a
 * structural read, not a prototype patch.
 * @param service - the `ctx.webServer` service instance.
 * @returns the live server, or undefined when the shape is unexpected.
 */
export function unwrapServer(service: unknown): Server | undefined {
  if (service === null || typeof service !== 'object') return undefined
  const candidate = (service as Record<string, unknown>).server
  if (candidate === undefined || typeof candidate !== 'object') return undefined
  const server = candidate as Server
  return typeof server.on === 'function' && typeof server.listeners === 'function'
    ? server
    : undefined
}

/** Structural helper used by the upgrade path; keeps the Duplex import live. */
export type { Duplex }