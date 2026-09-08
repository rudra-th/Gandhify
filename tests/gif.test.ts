import { test } from 'node:test'
import assert from 'node:assert/strict'
// gifenc's package.json `module` field points here; Vite serves this exact
// build, so the test exercises the same code the app runs.
import { GIFEncoder, quantize, applyPalette } from 'gifenc/dist/gifenc.esm.js'

// This mirrors src/worker.ts encodeGif() so the exact gifenc call signature
// used by the app is verified in Node (where no canvas exists).
function encodeGif(frames: Uint8ClampedArray[], width: number, height: number, delayMs: number, colors: number) {
  const gif = GIFEncoder()
  const delay = Math.max(1, Math.round(delayMs))
  const palette = quantize(frames[0], colors)
  for (const frame of frames) {
    const index = applyPalette(frame, palette)
    gif.writeFrame(index, width, height, { palette, delay })
  }
  gif.finish()
  return gif.bytes()
}

function makeFrame(seed: number, w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 3 + seed) & 255
    data[i * 4 + 1] = (i * 7 + seed) & 255
    data[i * 4 + 2] = (i * 11 + seed) & 255
    data[i * 4 + 3] = 255
  }
  return data
}

test('worker-style gifenc pipeline produces a valid GIF', () => {
  const w = 48
  const h = 48
  const frames = Array.from({ length: 24 }, (_, i) => makeFrame(i * 17, w, h))
  const bytes = encodeGif(frames, w, h, 55, 192)

  // GIF89a magic header + logical screen descriptor
  assert.equal(bytes.length > 100, true)
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2]), 'GIF')
  assert.equal(bytes[3], 0x38) // '8'
  // logical screen width/height little-endian
  assert.equal(bytes[6] | (bytes[7] << 8), w)
  assert.equal(bytes[8] | (bytes[9] << 8), h)
  // frame extended block present (graphics control ext) for animation
  const hasFrameExt = bytes.includes(0x21) && bytes.includes(0xf9)
  assert.equal(hasFrameExt, true)
})