import type { FrameSwaps } from './solver'

/**
 * Turn the raw per-generation slot exchanges into a flowing film: instead of
 * teleporting whole batches of pixels between frames, every pixel whose slot
 * changed this generation GLIDES along a straight line from where it started
 * to where it ends up, spread across `steps` intermediate frames.
 *
 * Glide quality details:
 *   - each mover starts at a slightly different instant (a deterministic hash
 *     of its origin slot), so a generation reads as a fluid wave rather than a
 *     single synchronized lurch;
 *   - motion is eased with smoothstep so pixels accelerate out of their slot
 *     and settle gently into the new one instead of plodding at fixed speed;
 *   - movers are drawn in "closest-to-destination first" order. When two paths
 *     cross mid-flight the slot is won by the pixel that has progressed further
 *     toward its final spot, which keeps the emerging picture from shimmering
 *     as tokens squeeze past each other.
 *
 * Because a generation's net effect is a permutation (swap chains threaded
 * through) every destination slot receives exactly one incoming pixel, the
 * final returned frame is exactly `cur` — the generation's true final state —
 * and every intermediate frame is `prev` with the movers at their eased
 * positions, so the parts of the picture that stay put keep their exact color
 * in every frame (the obamify "flow" feel).
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

  // moving tokens: [fromX, fromY, toX, toY, r, g, b, delay] per pixel on the
  // move. delay in [0, STAGGER) staggers the start instant.
  const STAGGER = 0.28
  const tokens: number[] = []
  for (let i = 0; i < N; i++) {
    if (perm[i] === i) continue
    const idx = i * 4
    const delay = (((Math.imul(i, 2654435761) >>> 12) % 1000) / 1000) * STAGGER
    tokens.push(
      i % side,
      (i / side) | 0,
      perm[i] % side,
      (perm[i] / side) | 0,
      prev[idx],
      prev[idx + 1],
      prev[idx + 2],
      delay,
    )
  }

  // smaller delay => further along at any point in the generation, so drawing
  // in ascending-delay order puts the most-settled pixels on top.
  const count = tokens.length / 8
  const order = Array.from({ length: count }, (_, k) => k).sort(
    (p, q) => tokens[p * 8 + 7] - tokens[q * 8 + 7],
  )

  const out: Uint8ClampedArray[] = []
  for (let f = 1; f <= F; f++) {
    const t = f / F
    const frame = prev.slice(0)
    for (const k of order) {
      const o = k * 8
      const span = 1 - tokens[o + 7]
      const u = Math.max(0, Math.min(1, (t - tokens[o + 7]) / span))
      const e = u * u * (3 - 2 * u) // smoothstep
      const x = tokens[o] + (tokens[o + 2] - tokens[o]) * e
      const y = tokens[o + 1] + (tokens[o + 3] - tokens[o + 1]) * e
      const slot = (Math.round(y) * side + Math.round(x)) * 4
      frame[slot] = tokens[o + 4]
      frame[slot + 1] = tokens[o + 5]
      frame[slot + 2] = tokens[o + 6]
      frame[slot + 3] = 255
    }
    out.push(frame)
  }
  return out
}