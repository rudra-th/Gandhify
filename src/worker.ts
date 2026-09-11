/// <reference lib="webworker" />
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import { solve, type ImageLike, type SolverSettings } from './solver'
import { buildSmoothFrames } from './smoothframes'

export interface GifOptions {
  delayMs: number
  maxFrames: number
  colors: number
  /** extra duration for the first frame, mirroring the on-screen hold on the source photo */
  holdMs: number
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
}

interface GifRetort {
  type: 'gif'
  id: number
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
  const colors = Math.min(256, Math.max(16, opts.colors))
  for (let i = 0; i < frames.length; i++) {
    const palette = quantize(frames[i], colors)
    const index = applyPalette(frames[i], palette)
    // first frame carries the on-screen source hold; repeat -1 emits no
    // NETSCAPE loop extension so the GIF plays once and stops on Gandhi
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.max(1, Math.round(opts.delayMs + (i === 0 ? opts.holdMs : 0))),
      repeat: i === 0 ? -1 : undefined,
    })
  }
  gif.finish()
  return gif.bytes()
}

/** sub-frames to synthesize for one generation, based on how many pixels
 *  actually moved (`swaps`). The solver does most of its work in the opening
 *  generations (gen 1 alone re-places ~30% of the image), so giving those
 *  many sub-frames turns the photo->Gandhi change into a slow dissolve instead
 *  of a sudden lurch; the quiet refinement tail gets one still per generation
 *  and ends quickly instead of lingering. */
function stepsForSwaps(swaps: number): number {
  return Math.max(1, Math.min(72, Math.round(swaps / 35)))
}

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
        const k = swaps ? swaps.a.length : 0
        const smooth = buildSmoothFrames(lastImg, image, swaps, stepsForSwaps(k))
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

    // arrive quickly so the result screen (and its replay film) appears the
    // moment the solve finishes; the GIF encode is comparatively slow (~10s)
    // and is delivered separately so the UI never looks stuck.
    const done: DoneRetort = {
      type: 'done',
      id: req.id,
      generations: result.generations,
      swaps: result.swaps,
      startCost: result.startCost,
      endCost: result.endCost,
    }
    ctx.postMessage(done)

    let gifBytes: Uint8Array | null = null
    if (store && req.gif) {
      const side = req.settings.sidelen
      const frames = store.sample(req.gif.maxFrames)
      gifBytes = frames.length > 0 ? encodeGif(frames, side, side, req.gif) : null
    }
    const gif: GifRetort = { type: 'gif', id: req.id, gifBytes }
    ctx.postMessage(gif, gifBytes ? { transfer: [gifBytes.buffer] } : {})
  } catch (err) {
    const retort: ErrorRetort = {
      type: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(retort)
  }
}