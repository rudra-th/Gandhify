import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSmoothFrames } from '../src/smoothframes.ts'

const sd = 8
const N = sd * sd

// unique 24-bit ids in the RGB channels make every pixel identifiable
function identImage(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) {
    data[i * 4] = (i >> 16) & 255
    data[i * 4 + 1] = (i >> 8) & 255
    data[i * 4 + 2] = i & 255
    data[i * 4 + 3] = 255
  }
  return data
}

function applySwapAt(buf: Uint8ClampedArray, a: number, b: number): void {
  for (let k = 0; k < 4; k++) {
    const t = buf[a * 4 + k]
    buf[a * 4 + k] = buf[b * 4 + k]
    buf[b * 4 + k] = t
  }
}

const swapPairs = [
  [3, 40],
  [7, 18],
  [12, 25],
  [1, 5],
  [30, 42],
  [9, 14],
  [20, 33],
  [0, 45],
  [28, 6],
]
const a = swapPairs.map((p) => p[0])
const b = swapPairs.map((p) => p[1])

const prev = identImage()
const cur = identImage()
for (const [x, y] of swapPairs) applySwapAt(cur, x, y)

test('replays the exact final state from a partial animation', () => {
  const out = buildSmoothFrames(prev, cur, { a, b }, 3)
  assert.equal(out.length, 3)
  assert.deepEqual(out[out.length - 1], cur)
  // intermediate frames are monotone stages toward the end state
  let mid = out[0]
  for (let j = 0; j < 3; j++) applySwapAt(mid, a[j], b[j])
  assert.deepEqual(out[0], mid)
})

test('no swaps -> single frame equal to cur', () => {
  assert.deepEqual(buildSmoothFrames(prev, cur, null, 3), [cur])
  assert.deepEqual(buildSmoothFrames(prev, cur, { a: [], b: [] }, 3), [cur])
})

test('first generation has no previous frame -> just cur', () => {
  assert.deepEqual(buildSmoothFrames(null, cur, { a, b }, 3), [cur])
})

test('all frames keep alpha opaque', () => {
  const out = buildSmoothFrames(prev, cur, { a, b }, 3)
  for (const f of out) {
    for (let i = 3; i < f.length; i += 4) assert.equal(f[i], 255)
  }
})