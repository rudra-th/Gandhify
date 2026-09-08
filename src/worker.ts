/// <reference lib="webworker" />
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import { solve, type ImageLike, type SolverSettings } from './solver'
import { buildSmoothFrames } from './smoothframes'

export interface GifOptions {
  delayMs: number
  maxFrames: number
  colors: number
}

interface JobRequest {
  id: number
  source: ImageLike
  target: ImageLike
  weights: ImageLike
  settings: SolverSettings
  gif: GifOptions | null
}

interface FrameRetort {
  type: 'frame'
  id: number
  side: number
  generation: number
  progress: number
  data: Uint8ClampedArray
}

interface DoneRetort {
  type: 'done'
  id: number
  generations: number
  swaps: number
  startCost: number
  endCost: number
  gifBytes: Uint8Array | null
}

interface ErrorRetort {
  type: 'error'
  id: number
  message: string
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

function createFrameStore(maxFrames: number) {
  let frames: Uint8ClampedArray[] = []
  const cap = maxFrames * 2
  return {
    push(img: Uint8ClampedArray) {
      frames.push(img)
      if (frames.length > cap) {
        const next: Uint8ClampedArray[] = []
        for (let i = 0; i < frames.length; i += 2) next.push(frames[i])
        frames = next
      }
    },
    sample(count: number): Uint8ClampedArray[] {
      if (frames.length === 0) return []
      const stride = Math.ceil(frames.length / count)
      const out: Uint8ClampedArray[] = []
      for (let i = 0; i < frames.length; i += stride) out.push(frames[i])
      // GIFs also stop on the final frame — keep the exact end state
      if (out[out.length - 1] !== frames[frames.length - 1]) out.push(frames[frames.length - 1])
      return out
    },
  }
}

function encodeGif(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  opts: GifOptions,
): Uint8Array {
  const gif = GIFEncoder()
  const delay = Math.max(1, Math.round(opts.delayMs))
  const colors = Math.min(256, Math.max(16, opts.colors))
  for (const frame of frames) {
    const palette = quantize(frame, colors)
    const index = applyPalette(frame, palette)
    gif.writeFrame(index, width, height, { palette, delay })
  }
  gif.finish()
  return gif.bytes()
}

/** how many in-between frames to synthesize per generation of swaps.
 *  12 small batches per generation keeps most pixels still at any instant,
 *  so the morph creeps into place organically (obamify-style) instead of
 *  churning the whole image at once. */
const SMOOTH_STEPS = 12

ctx.onmessage = (event: MessageEvent<JobRequest>) => {
  const req = event.data
  try {
    const store = req.gif ? createFrameStore(req.gif.maxFrames) : null

    let lastImg: Uint8ClampedArray | null = null
    let lastProgress = 0

    const result = solve({
      source: req.source,
      target: req.target,
      weights: req.weights,
      settings: req.settings,
      onFrame: (generation, progress, swaps, image) => {
        const saved = image.slice(0) // keep a worker copy before transferring
        const smooth = buildSmoothFrames(lastImg, image, swaps, SMOOTH_STEPS)
        const n = smooth.length
        for (let i = 0; i < n; i++) {
          const frame = smooth[i]
          if (store) store.push(frame.slice(0))
          const p = n > 1 ? lastProgress + ((progress - lastProgress) * (i + 1)) / n : progress
          const retort: FrameRetort = {
            type: 'frame',
            id: req.id,
            side: req.settings.sidelen,
            generation,
            progress: p,
            data: frame,
          }
          ctx.postMessage(retort, { transfer: [frame.buffer] })
        }
        lastImg = saved
        lastProgress = progress
      },
    })

    let gifBytes: Uint8Array | null = null
    if (store && req.gif) {
      const side = req.settings.sidelen
      const frames = store.sample(req.gif.maxFrames)
      gifBytes = frames.length > 0 ? encodeGif(frames, side, side, req.gif) : null
    }

    const done: DoneRetort = {
      type: 'done',
      id: req.id,
      generations: result.generations,
      swaps: result.swaps,
      startCost: result.startCost,
      endCost: result.endCost,
      gifBytes,
    }
    ctx.postMessage(done, gifBytes ? { transfer: [gifBytes.buffer] } : {})
  } catch (err) {
    const retort: ErrorRetort = {
      type: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(retort)
  }
}