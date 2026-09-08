import type { FrameSwaps } from './solver'

/**
 * Turn the raw per-generation jumps into a continuous film: the swaps a
 * generation accepted (in the order the solver made them) are spread across
 * at most `steps` intermediate frames, so pixels visibly slide into their new
 * slots instead of teleporting. The returned array always ends with `cur`
 * exactly (the generation's true final state).
 */
export function buildSmoothFrames(
  prev: Uint8ClampedArray | null,
  cur: Uint8ClampedArray,
  swaps: FrameSwaps | null,
  steps: number,
): Uint8ClampedArray[] {
  if (!prev || !swaps || swaps.a.length === 0) return [cur]
  const total = swaps.a.length
  const chunk = Math.max(1, Math.ceil(total / steps))
  const work = prev.slice(0)
  const out: Uint8ClampedArray[] = []
  let start = 0
  while (start < total) {
    const end = Math.min(start + chunk, total)
    for (let j = start; j < end; j++) {
      let a = swaps.a[j] * 4
      let b = swaps.b[j] * 4
      for (let k = 0; k < 4; k++) {
        const t = work[a + k]
        work[a + k] = work[b + k]
        work[b + k] = t
      }
    }
    start = end
    if (start < total) out.push(work.slice(0))
  }
  // applying all swaps reproduces the generation's true final state == `cur`
  out.push(cur)
  return out
}