import type { FrameSwaps } from './solver'

/**
 * Turn the raw per-generation slot exchanges into a flowing film: instead of
 * teleporting whole batches of pixels between frames, every pixel whose slot
 * changed this generation GLIDES along a straight line from where it started
 * to where it ends up, spread across `steps` intermediate frames.
 *
 * Because a generation's net effect is a permutation (swap chains threaded
 * through) every destination slot receives exactly one incoming pixel, so the
 * grid stays fully covered. The final returned frame is exactly `cur` — the
 * generation's true final state — and no pixels that are NOT on the move ever
 * change, so most of the picture stays still while the moving slivers creep
 * into place (the obamify "flow" feel).
 */
export function buildSmoothFrames(
  prev: Uint8ClampedArray | null,
  cur: Uint8ClampedArray,
  swaps: FrameSwaps | null,
  steps: number,
): Uint8ClampedArray[] {
  if (!prev || !swaps || swaps.a.length === 0) return [cur]
  const N = cur.length / 4
  const side = Math.round(Math.sqrt(N))
  const F = Math.max(1, Math.floor(steps))

  // net permutation: the content that starts at slot i ends at perm[i]
  const perm = new Int32Array(N)
  for (let i = 0; i < N; i++) perm[i] = i
  for (let j = 0; j < swaps.a.length; j++) {
    const x = perm[swaps.a[j]]
    perm[swaps.a[j]] = perm[swaps.b[j]]
    perm[swaps.b[j]] = x
  }

  // moving tokens: [fromX, fromY, toX, toY, r, g, b] per pixel on the move
  const tokens: number[] = []
  for (let i = 0; i < N; i++) {
    if (perm[i] === i) continue
    const idx = i * 4
    tokens.push(
      i % side,
      (i / side) | 0,
      perm[i] % side,
      (perm[i] / side) | 0,
      prev[idx],
      prev[idx + 1],
      prev[idx + 2],
    )
  }

  const out: Uint8ClampedArray[] = []
  for (let f = 1; f <= F; f++) {
    const t = f / F
    const frame = prev.slice(0)
    for (let k = 0; k < tokens.length; k += 7) {
      const x = tokens[k] + (tokens[k + 2] - tokens[k]) * t
      const y = tokens[k + 1] + (tokens[k + 3] - tokens[k + 1]) * t
      const slot = (Math.round(y) * side + Math.round(x)) * 4
      frame[slot] = tokens[k + 4]
      frame[slot + 1] = tokens[k + 5]
      frame[slot + 2] = tokens[k + 6]
      frame[slot + 3] = 255
    }
    out.push(frame)
  }
  return out
}