// `vinfo_proxy` 的 `enc: 1` 播放信息（API.md §4.1，App 的 TencentVinfoCipher）：JSON 里每个可打印 ASCII 字符（32–126）
// 每 64 个一块，经一个由请求自己的值和页面盐 `xs` 派生的置换表替换；其他字符原样。照播放页的解码器（`index-*.js`，
// 2026-11）移植，按 JavaScript 的 UTF-16 单元算。

const FIRST = 32
const LAST = 126
const COUNT = LAST - FIRST + 1
const FNV_BASIS = 2_166_136_261
const FNV_PRIME = 16_777_619
const BLOCK = 64

/** 密钥串：`vuid`（或 `guest`）+ `video_guid` + 请求里的 `cid`、`vid` + 答复的 `flowid`。 */
export function vinfoKey(vuid: string | undefined, guid: string, cid: string, vid: string, flowid: string): string {
  return (vuid ? vuid : 'guest') + guid + cid + vid + flowid
}

/** FNV-1a（按 UTF-16 单元；密钥是 ASCII）。 */
function fnv(input: string): number {
  let hash = FNV_BASIS
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), FNV_PRIME) >>> 0
  return hash === 0 ? FNV_BASIS : hash
}

function mix(value: number): number {
  let x = value >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 2_146_121_005) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 2_221_713_035) >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  return x === 0 ? FNV_BASIS : x
}

/** 0…94 的 Fisher–Yates 洗牌，由一个四字的小生成器驱动；`inverse` 把密文字符映射回明文字符。 */
function shuffle(seed: number, permutation: Uint8Array, inverse: Uint8Array): void {
  for (let i = 0; i < COUNT; i++) permutation[i] = i
  let s = mix(seed ^ 608_135_816)
  let a = mix(seed ^ 2_242_054_355)
  let u = mix(seed ^ 320_440_878)
  let l = mix(seed ^ 57_701_188)
  for (let c = COUNT - 1; c > 0; c--) {
    const d = (s + a + l) >>> 0
    l = (l + 1) >>> 0
    s = (a ^ (a >>> 9)) >>> 0
    a = (u + ((u << 3) >>> 0)) >>> 0
    u = ((u << 21) | (u >>> 11)) >>> 0
    u = (u + d) >>> 0
    const f = d % (c + 1)
    const t = permutation[c]!
    permutation[c] = permutation[f]!
    permutation[f] = t
  }
  for (let c = 0; c < COUNT; c++) inverse[FIRST + permutation[c]!] = FIRST + c
}

export function decryptVinfo(input: string, key: string, salt: string): string {
  if (!key || !salt) return input
  const output = new Array<number>(input.length)
  const seed = fnv(`${key}:salt:${salt}`)
  const permutation = new Uint8Array(COUNT)
  const inverse = new Uint8Array(LAST + 1)
  let checksum = mix((seed ^ 2_779_096_485) >>> 0) & 255
  for (let start = 0; start < input.length; start += BLOCK) {
    const index = Math.floor(start / BLOCK)
    const step = Math.imul(index + 1, 2_654_435_761) >>> 0
    shuffle(mix((seed ^ step ^ checksum) >>> 0), permutation, inverse)
    let running = checksum
    for (let position = start; position < Math.min(start + BLOCK, input.length); position++) {
      const unit = input.charCodeAt(position)
      if (unit > 255) {
        output[position] = unit
        running = (running + (unit & 255)) & 255
        continue
      }
      let value = unit
      if (value >= FIRST && value <= LAST) value = inverse[value]!
      output[position] = value
      running = (running + value) & 255
    }
    checksum = running
  }
  let result = ''
  for (let i = 0; i < output.length; i += 8192) result += String.fromCharCode(...output.slice(i, i + 8192))
  return result
}
