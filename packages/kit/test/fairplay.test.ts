import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Manifest } from '@iyt-source/protocol'
import { createServer, fairPlayEndpoints, SourceError, type SourcePlugin } from '../src/index.ts'

describe('FairPlay relay', () => {
  const data = mkdtempSync(join(tmpdir(), 'iyt-fairplay-'))
  afterAll(() => rmSync(data, { recursive: true, force: true }))

  const plugin: SourcePlugin = {
    info: { name: 'F' },
    detail: { detail: async () => { throw new Error('unused') } },
    playback: {
      resolve: async () => { throw new Error('unused') },
      fairPlay: {
        async certificate(ref) { return new TextEncoder().encode(`cert:${ref}`) },
        async license(ref, spc) {
          if (ref === 'denied') throw new SourceError('restricted', '没有权限')
          return Uint8Array.from([...new TextEncoder().encode(`ckc:${ref}:`), ...spc])
        },
      },
    },
  }

  it('declares the feature and relays certificate and license as raw bytes', async () => {
    const server = await createServer({ name: 't', dataDir: data, debug: false, sources: [{ id: 'f', plugin }] })
    try {
      const headers = { host: 'localhost' }
      const manifest = (await server.app.inject({ method: 'GET', url: '/iyt/v1/manifest', headers })).json() as Manifest
      expect(manifest.sources[0].features.fairPlay).toBe(true)

      const endpoints = fairPlayEndpoints('f', 'v1/4k')
      expect(endpoints).toEqual({ certificate: '/iyt/v1/sources/f/fairplay/v1%2F4k/cert', license: '/iyt/v1/sources/f/fairplay/v1%2F4k/license' })

      const cert = await server.app.inject({ method: 'GET', url: endpoints.certificate, headers })
      expect(cert.headers['content-type']).toBe('application/octet-stream')
      expect(cert.body).toBe('cert:v1/4k')

      const license = await server.app.inject({
        method: 'POST', url: endpoints.license, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from([1, 2, 3]),
      })
      expect(license.statusCode).toBe(200)
      expect([...license.rawPayload]).toEqual([...new TextEncoder().encode('ckc:v1/4k:'), 1, 2, 3])

      const empty = await server.app.inject({ method: 'POST', url: endpoints.license, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(0) })
      expect(empty.statusCode).toBe(400)
      const denied = await server.app.inject({
        method: 'POST', url: fairPlayEndpoints('f', 'denied').license, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from([9]),
      })
      expect(denied.statusCode).toBe(403)
    } finally {
      await server.close()
    }
  })
})
