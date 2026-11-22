import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Manifest } from '@iyt-source/protocol'
import { clientDrm, createServer, drmEndpoints, fairPlayEndpoints, SourceError, type SourcePlugin } from '../src/index.ts'

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

  it('relays Widevine through the generic DRM module and keeps the FairPlay paths', async () => {
    const calls: string[] = []
    const drmPlugin: SourcePlugin = {
      info: { name: 'D' },
      detail: { detail: async () => { throw new Error('unused') } },
      playback: {
        resolve: async () => { throw new Error('unused') },
        drm: {
          systems: ['fairplay', 'widevine'],
          async certificate(system, ref) { return new TextEncoder().encode(`${system}-cert:${ref}`) },
          async license(system, ref, request) { calls.push(`${system}:${ref}:${request.length}`); return Uint8Array.from([7, 7]) },
        },
      },
    }
    const server = await createServer({ name: 't', dataDir: data, debug: false, sources: [{ id: 'd', plugin: drmPlugin }] })
    try {
      const headers = { host: 'localhost' }
      const manifest = (await server.app.inject({ method: 'GET', url: '/iyt/v1/manifest', headers })).json() as Manifest
      expect(manifest.sources[0].features).toMatchObject({ fairPlay: true, drm: ['fairplay', 'widevine'] })

      const endpoints = drmEndpoints('d', 'x1', ['fairplay', 'widevine'])
      expect(endpoints.drm).toEqual([
        { system: 'fairplay', certificate: '/iyt/v1/sources/d/drm/fairplay/x1/cert', license: '/iyt/v1/sources/d/drm/fairplay/x1/license' },
        { system: 'widevine', license: '/iyt/v1/sources/d/drm/widevine/x1/license' },
      ])
      expect(endpoints.fairPlay).toEqual({ certificate: endpoints.drm[0].certificate, license: endpoints.drm[0].license })
      expect(drmEndpoints('d', 'x1', ['widevine']).fairPlay).toBeUndefined()

      const post = (url: string) => server.app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from([1, 2, 3]) })
      expect((await post(endpoints.drm[1].license)).statusCode).toBe(200)
      expect((await post(endpoints.drm[0].license)).statusCode).toBe(200)
      // 旧地址仍可用。
      expect((await post(fairPlayEndpoints('d', 'x1').license)).statusCode).toBe(200)
      expect(calls).toEqual(['widevine:x1:3', 'fairplay:x1:3', 'fairplay:x1:3'])
      expect((await server.app.inject({ method: 'GET', url: '/iyt/v1/sources/d/drm/widevine/x1/cert', headers })).statusCode).toBe(200)
      expect((await post('/iyt/v1/sources/d/drm/playready/x1/license')).statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('treats a client that says nothing as FairPlay-only', () => {
    expect(clientDrm({})).toEqual(['fairplay'])
    expect(clientDrm({ preferences: { drm: [] } })).toEqual([])
    expect(clientDrm({ preferences: { drm: ['widevine'] } })).toEqual(['widevine'])
  })
})
