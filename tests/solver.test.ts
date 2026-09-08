import { test } from 'node:test'
import assert from 'node:assert/strict'
import { solve, type ImageLike } from '../src/solver.ts'

function makeImage(sidelen: number, fill: (x: number, y: number, i: number) => [number, number, number]): ImageLike {
  const data = new Uint8ClampedArray(sidelen * sidelen * 4)
  for (let y = 0; y < sidelen; y++) {
    for (let x = 0; x < sidelen; x++) {
      const i = y * sidelen + x
      const [r, g, b] = fill(x, y, i)
      data[i * 4] = r
      data[i * 4 + 1] = g
      data[i * 4 + 2] = b
      data[i * 4 + 3] = 255
    }
  }
  return { width: sidelen, height: sidelen, data }
}

const sd = 32
const N = sd * sd

// every source pixel carries a unique 24-bit id -> a shuffled output whose
// per-pixel multiset matches the source is necessarily a bijection.
const source = makeImage(sd, (_x, _y, i) => [(i >> 16) & 255, (i >> 8) & 255, i & 255])
const target = makeImage(sd, (x, y) => [(x * 8) % 256, (y * 8) % 256, ((x + y) * 4) % 256])
// grayscale importance map, encoded in the red channel
const weights = makeImage(sd, (x, y) => {
  const dx = x - sd / 2
  const dy = y - sd / 2
  const gray = 255 - Math.min(255, Math.hypot(dx, dy) * 6)
  return [gray, gray, gray]
})

const base = {
  sidelen: sd,
  proximityImportance: 6,
  seed: 7,
}

test('solves deterministically with a fixed seed', () => {
  const a = solve({ source: clone(source), target, weights, settings: base })
  const b = solve({ source: clone(source), target, weights, settings: base })
  assert.deepEqual(a.output, b.output)
  assert.equal(a.generations, b.generations)
  assert.equal(a.swaps, b.swaps)
})

test('output is a bijection of the source pixels', () => {
  const out = solve({ source: clone(source), target, weights, settings: base })
  const pack = (img: Uint8ClampedArray) => {
    const ids = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      ids[i] = (img[i * 4] << 16) | (img[i * 4 + 1] << 8) | img[i * 4 + 2]
    }
    return ids.sort()
  }
  assert.deepEqual(pack(out.output), pack(source.data))
})

test('total cost never increases over the run', () => {
  const out = solve({ source: clone(source), target, weights, settings: base })
  assert.ok(out.endCost <= out.startCost, `endCost ${out.endCost} > startCost ${out.startCost}`)
  assert.ok(out.generations >= 20, `expected >=20 generations, got ${out.generations}`)
  assert.ok(out.generations <= 40, `expected <=40 generations, got ${out.generations}`)
})

test('preserves alpha and reports plausible stats', () => {
  const frames: number[] = []
  const out = solve({
    source: clone(source),
    target,
    weights,
    settings: base,
    onFrame: (gen) => {
      frames.push(gen)
    },
  })
  assert.equal(out.output.length, N * 4)
  for (let i = 0; i < out.output.length; i += 4) {
    assert.equal(out.output[i + 3], 255)
  }
  assert.ok(out.swaps > 0)
  assert.ok(frames.length >= 1)
  // one initial frame (generation 0) + one per generation
  assert.equal(frames.length, out.generations + 1)
})

function clone(img: ImageLike): ImageLike {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
}