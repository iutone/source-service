import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Manifest } from '@iyt-source/protocol'
import { createServer, type SourcePlugin } from '../src/index.ts'
import { loadConfig, saveVisibility } from '../../cli/src/config.ts'

const plugin = (name: string): SourcePlugin => ({
  info: { name },
  detail: { detail: async () => { throw new Error('unused') } },
  playback: { resolve: async () => { throw new Error('unused') } },
})

describe('source visibility', () => {
  const data = mkdtempSync(join(tmpdir(), 'iyt-visibility-'))
  afterAll(() => rmSync(data, { recursive: true, force: true }))

  it('lists auto and discoverable sources, hidden ones only with all=1', async () => {
    const server = await createServer({
      name: 't', dataDir: data, debug: false,
      sources: [
        { id: 'a', plugin: plugin('A'), visibility: 'auto' },
        { id: 'b', plugin: plugin('B') },
        { id: 'c', plugin: plugin('C'), visibility: 'hidden' },
      ],
    })
    try {
      const get = async (url: string) => (await server.app.inject({ method: 'GET', url, headers: { host: 'localhost' } })).json() as Manifest
      const listed = await get('/iyt/v1/manifest')
      expect(listed.sources.map((s) => [s.id, s.visibility])).toEqual([['a', 'auto'], ['b', 'discoverable']])
      const all = await get('/iyt/v1/manifest?all=1')
      expect(all.sources.map((s) => [s.id, s.visibility])).toEqual([['a', 'auto'], ['b', 'discoverable'], ['c', 'hidden']])
      // 隐藏的源的接口照常可用。
      const account = await server.app.inject({ method: 'GET', url: '/iyt/v1/sources/c/account', headers: { host: 'localhost' } })
      expect(account.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('reads visibility from the config and refuses unknown values', () => {
    const file = join(data, 'config.yaml')
    writeFileSync(file, 'sources:\n  - { id: a, plugin: x, visibility: auto }\n  - { id: b, plugin: y }\n')
    expect(loadConfig(file).config.sources.map((s) => s.visibility)).toEqual(['auto', undefined])
    writeFileSync(file, 'sources:\n  - { id: a, plugin: x, visibility: shown }\n')
    expect(() => loadConfig(file)).toThrow(/visibility/)
  })

  it('changes a source\'s visibility from the debug page and saves it', async () => {
    const saved: [string, string][] = []
    const server = await createServer({
      name: 't', dataDir: data,
      sources: [{ id: 'a', plugin: plugin('A') }],
      saveVisibility: (id, visibility) => { saved.push([id, visibility]) },
    })
    try {
      const post = (body: unknown) => server.app.inject({ method: 'POST', url: '/debug/api/visibility', payload: body as object, headers: { host: 'localhost' } })
      expect((await post({ source: 'a', visibility: 'hidden' })).statusCode).toBe(200)
      expect(saved).toEqual([['a', 'hidden']])
      const listed = (await server.app.inject({ method: 'GET', url: '/iyt/v1/manifest', headers: { host: 'localhost' } })).json() as Manifest
      expect(listed.sources).toEqual([])
      expect((await post({ source: 'a', visibility: 'shown' })).statusCode).toBe(400)
      expect((await post({ source: 'x', visibility: 'auto' })).statusCode).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('writes visibility back to the config, keeping comments', () => {
    const file = join(data, 'save.yaml')
    writeFileSync(file, 'name: t\nsources:\n  # 常用的\n  - id: a\n    plugin: x\n  - { id: b, plugin: y, visibility: hidden }\n')
    saveVisibility(file, 'a', 'auto')
    saveVisibility(file, 'b', 'discoverable')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('# 常用的')
    expect(loadConfig(file).config.sources.map((s) => [s.id, s.visibility])).toEqual([['a', 'auto'], ['b', undefined]])
    expect(() => saveVisibility(file, 'zz', 'auto')).toThrow(/zz/)
  })
})
