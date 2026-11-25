import type { ContentVersion, Seed, SourceQuestionId } from './model'

export const SHUFFLE_ALGORITHM = 'fnv1a-mulberry32-fisher-yates-v1'
const range = 0x1_0000_0000

function hashSeed(value: string): number {
  // Hash UTF-16 code units with JS-defined 32-bit multiplication; no platform-dependent sort.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

function stream(seed: Seed, contentVersion: ContentVersion, scope: string): () => number {
  if (typeof seed === 'number' && !Number.isFinite(seed)) throw new Error('Invalid numeric shuffle seed')
  let state = hashSeed(JSON.stringify([SHUFFLE_ALGORITHM, typeof seed, seed, contentVersion, scope]))
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (value ^ (value >>> 14)) >>> 0
  }
}

function indexBelow(next: () => number, upper: number): number {
  const limit = range - (range % upper)
  let draw = next()
  while (draw >= limit) draw = next()
  return draw % upper
}

/** Stable identity sort, then a versioned seeded Fisher–Yates shuffle of a copy. */
export function seededShuffle<T>(
  items: readonly T[],
  seed: Seed,
  contentVersion: ContentVersion,
  identity?: (item: T) => string,
  scope = 'question-order',
): readonly T[] {
  const keyed = Array.from(items, (item) => {
    if (identity) return { item, key: identity(item) }
    if (typeof item === 'string' || typeof item === 'number') return { item, key: `${typeof item}:${item}` }
    throw new Error('Shuffle of non-primitive items requires a stable identity')
  })
  keyed.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index]?.key === keyed[index - 1]?.key) throw new Error('Duplicate shuffle identity')
  }
  const shuffled = keyed.map(({ item }) => item)
  const next = stream(seed, contentVersion, scope)
  for (let end = shuffled.length - 1; end > 0; end -= 1) {
    const selected = indexBelow(next, end + 1)
    const item = shuffled[end] as T
    shuffled[end] = shuffled[selected] as T
    shuffled[selected] = item
  }
  return Object.freeze(shuffled)
}

export function seededQuestionOrder(
  ids: readonly SourceQuestionId[],
  seed: Seed,
  contentVersion: ContentVersion,
  scope = 'question-order',
): readonly SourceQuestionId[] {
  return seededShuffle(ids, seed, contentVersion, (id) => id, scope)
}
