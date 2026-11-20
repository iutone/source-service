import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import { describe, expect, it } from 'vitest'
import { buildFixtures, render, type FixtureCase } from '../../../scripts/fixtures-lib.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures')
const schema = JSON.parse(readFileSync(join(here, '../schema/protocol.schema.json'), 'utf8')) as { definitions: Record<string, unknown> }

const ajv = new Ajv({ allErrors: true, strict: false })
ajv.addSchema(schema, 'protocol')

function validator(type: string) {
  const array = type.endsWith('[]')
  const ref = { $ref: `protocol#/definitions/${array ? type.slice(0, -2) : type}` }
  return ajv.compile(array ? { type: 'array', items: ref } : ref)
}

describe('fixtures', async () => {
  const { index, bodies } = await buildFixtures()

  it('are up to date (run `pnpm fixtures` after changing the protocol or the sample source)', () => {
    expect(readFileSync(join(fixtures, 'index.json'), 'utf8')).toBe(render(index))
    for (const [name, body] of bodies) {
      expect(readFileSync(join(fixtures, `${name}.json`), 'utf8'), name).toBe(render(body))
    }
  })

  it.each(index.filter((entry): entry is FixtureCase & { type: string } => Boolean(entry.type)).map((entry) => [entry.name, entry] as const))(
    '%s matches its schema',
    (name, entry) => {
      const validate = validator(entry.type)
      const ok = validate(bodies.get(name))
      expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true)
    },
  )

  it('cover every route the server registers', async () => {
    const { createServer } = await import('@iyt-source/kit')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const data = mkdtempSync(join(tmpdir(), 'iyt-routes-'))
    const server = await createServer({ name: 'r', dataDir: data, sources: [] , debug: false})
    const routes = server.routes
    await server.close()
    rmSync(data, { recursive: true, force: true })
    const covered = new Set(index.map((entry) => `${entry.method} ${entry.path.split('?')[0].replace('/sources/sample', '/sources/:source').replace(/\/login\/\{loginId\}$/, '/login/:loginId').replace(/\/subtitles\/[^/]+\/[^/]+$/, '/subtitles/:ref/:key')}`))
    // 不需要 fixture 的：写操作的同类、资源与媒体文件。
    const exempt = ['/assets/:name', '/media/:token/*', '/login/:loginId/cancel', '/actions/dislike', '/actions/coins', '/actions/follow', '/history/clear', 'POST /iyt/v1/sources/:source/actions/favorites']
    const missing = routes
      .filter((route) => route.includes('/iyt/v1/'))
      .filter((route) => !covered.has(route) && !exempt.some((suffix) => route.endsWith(suffix)))
    expect(routes.filter((route) => route.includes('/iyt/v1/')).length).toBeGreaterThan(40)
    expect(missing).toEqual([])
  })
})
