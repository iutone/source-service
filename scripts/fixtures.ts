// pnpm fixtures：重新生成 packages/protocol/fixtures 与 schema。
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFixtures } from './fixtures-lib.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const count = await writeFixtures(join(root, 'packages/protocol/fixtures'))
execFileSync(join(root, 'node_modules/.bin/ts-json-schema-generator'), [
  '--path', join(root, 'packages/protocol/src/types.ts'),
  '--tsconfig', join(root, 'tsconfig.json'),
  '--type', '*',
  '--expose', 'export',
  '--no-type-check',
  '-o', join(root, 'packages/protocol/schema/protocol.schema.json'),
], { stdio: 'inherit' })
console.log(`${count} 个 fixture 与 schema 已更新`)
