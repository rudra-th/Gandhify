/**
 * Candhify core solver.
 *
 * Genetic color-reassignment solver, faithfully ported from the "fast"
 * genetic variant of the algorithm used by Obamify
 * (https://github.com/Spu7Nix/obamify, MIT License).
 *
 * How it works:
 *   - Our photo and the Gandhi target are both placed on an NxN grid.
 *   - We want a bijection from target cells -> source cells so that the final
 *     image "reads" as Gandhi: each target cell gets the color of whichever
 *     source cell has (a) a similar color there, weighted by how important
 *     that region of the target is, and (b) not too far from its original
 *     spot (kept smooth by the `proximityImportance` term).
 *   - Solving exactly (Hungarian / Kuhn-Munkres) is `O(N^3)` and intractable
 *     in a browser, so we use the simulated-annealing-style genetic method:
 *     repeatedly try random local swaps and keep the ones that lower cost,
 *     shrinking the search radius each generation until it converges.
 *
 * This module is deliberately pure and dependency-free so it runs unchanged
 * in browsers (Web Worker) and Node (tests + headless evaluation).
 */

export interface ImageLike {
  width: number
  height: number
  /** RGBA bytes, width*height*4 */
  data: Uint8ClampedArray<ArrayBuffer>
}

export interface SolverSettings {
  /** grid is sidelen x sidelen cells */
  sidelen: number
  /** spatial cost weight; higher = output stays closer to the original photo.
   *  6 keeps the face strongly Gandhified; 13+ is the subtle (obamify) default */
  proximityImportance: number
  /** swap attempts per pixel per generation (Obamify uses 128; 64 is ~2x faster) */
  swapsPerPixelPerGeneration?: number
  /** hard cap on generations */
  maxGenerations?: number
  /** once maxDist shrinks below this AND a generation made this few swaps, stop */
  minSearchRadius?: number
  /** deterministic RNG seed (defaults to a random value) */
  seed?: number
}

export interface SolveStats {
  generations: number
  swaps: number
  startCost: number
  endCost: number
}

export interface SolveResult extends SolveStats {
  /** final RGBA image, sidelen*sidelen*4, alpha = 255 */
  output: Uint8ClampedArray
}

/** slot pairs swapped during one generation (chronological order). */
export interface FrameSwaps {
  a: number[]
  b: number[]
}

export type FrameCallback = (
  generation: number,
  progress: number, // 0..1
  swaps: FrameSwaps | null, // accepted slot swaps that produced this generation
  image: Uint8ClampedArray, // fresh RGBA allocation, sidelen*sidelen*4
) => void

export interface SolveOptions {
  /** must already be square, sidelen x sidelen */
  source: ImageLike
  /** must already be square, sidelen x sidelen */
  target: ImageLike
  /** grayscale importance map, weights in the red channel; sidelen x sidelen */
  weights: ImageLike
  settings: SolverSettings
  onFrame?: FrameCallback
}

/** Deterministic, fast integer PRNG (xorshift32). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  if (s === 0) s = 0x9e3779b9
  return function next() {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s
  }
}

export function solve(options: SolveOptions): SolveResult {
  const { source, target, weights, settings, onFrame } = options
  const sidelen = settings.sidelen
  const prox = settings.proximityImportance
  const N = sidelen * sidelen

  if (source.width !== sidelen || source.height !== sidelen) {
    throw new Error(`source must be ${sidelen}x${sidelen}`)
  }
  if (target.width !== sidelen || target.height !== sidelen) {
    throw new Error(`target must be ${sidelen}x${sidelen}`)
  }
  if (weights.width !== sidelen || weights.height !== sidelen) {
    throw new Error(`weights must be ${sidelen}x${sidelen}`)
  }

  const swapsPerPixel = settings.swapsPerPixelPerGeneration ?? 64
  const maxGenerations = settings.maxGenerations ?? 800
  const minSearchRadius = settings.minSearchRadius ?? 4
  const swapAttemptsPerGeneration = swapsPerPixel * N

  // ---- per-cell arrays -----------------------------------------------------
  // cell index `i` = slot i (target grid row-major position i).
  // cell at slot i also holds its original source position (cellSrc[i]).
  const cellSrc = new Int32Array(N) // source cell index currently in slot i
  const cellR = new Int32Array(N)
  const cellG = new Int32Array(N)
  const cellB = new Int32Array(N)
  const h = new Float64Array(N) // current cost of the cell in slot i

  // source cell positions
  const srcX = new Int32Array(N)
  const srcY = new Int32Array(N)
  const gridX = new Int32Array(N) // x of slot i (== slot index % sidelen)
  const gridY = new Int32Array(N)

  // target colors + weights
  const targetR = new Int32Array(N)
  const targetG = new Int32Array(N)
  const targetB = new Int32Array(N)
  const w = new Int32Array(N)

  const sd = sidelen
  for (let i = 0; i < N; i++) {
    const x = i % sd
    const y = (i / sd) | 0
    const sOff = i * 4
    const tOff = i * 4
    srcX[i] = x
    srcY[i] = y
    gridX[i] = x
    gridY[i] = y
    cellSrc[i] = i
    cellR[i] = source.data[sOff]
    cellG[i] = source.data[sOff + 1]
    cellB[i] = source.data[sOff + 2]
    targetR[i] = target.data[tOff]
    targetG[i] = target.data[tOff + 1]
    targetB[i] = target.data[tOff + 2]
    w[i] = weights.data[tOff] // gray level lives in the red channel
  }

  // cost(cell i, slot j): cost of placing the cell currently in slot i
  // into slot j. Inlined below.
  const costAtHome = (i: number): number => {
    const sx = srcX[cellSrc[i]]
    const sy = srcY[cellSrc[i]]
    const jx = gridX[i]
    const jy = gridY[i]
    const dx = jx - sx
    const dy = jy - sy
    const sp = dx * dx + dy * dy
    const cr = cellR[i] - targetR[i]
    const cg = cellG[i] - targetG[i]
    const cb = cellB[i] - targetB[i]
    const col = cr * cr + cg * cg + cb * cb
    return col * w[i] + sp * sp * prox * prox
  }

  let startCost = 0
  for (let i = 0; i < N; i++) {
    h[i] = costAtHome(i)
    startCost += h[i]
  }

  const render = (): Uint8ClampedArray => {
    const img = new Uint8ClampedArray(N * 4)
    for (let i = 0; i < N; i++) {
      const o = i * 4
      img[o] = cellR[i]
      img[o + 1] = cellG[i]
      img[o + 2] = cellB[i]
      img[o + 3] = 255
    }
    return img
  }

  const rng = makeRng(settings.seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0)

  const AX = gridX
  const AY = gridY
  const SRCX = srcX
  const SRCY = srcY
  const TR = targetR
  const TG = targetG
  const TB = targetB
  const WW = w
  const CR = cellR
  const CG = cellG
  const CB = cellB
  const CS = cellSrc
  const HH = h
  const prox2 = prox * prox
  const TOT = N

  let maxDist = sd
  let generation = 0
  let totalSwaps = 0
  let stale = 0

  // slot pairs swapped during the current generation (chronological order)
  const genSwapA: number[] = []
  const genSwapB: number[] = []

  // initial frame (the source photo as-is)
  onFrame?.(generation, 0, null, render())

  while (generation < maxGenerations) {
    generation++
    genSwapA.length = 0
    genSwapB.length = 0
    let swapsMade = 0
    const RANGE = 2 * maxDist + 1
    const nd = sd - 1
    const mD = maxDist

    for (let attempt = 0; attempt < swapAttemptsPerGeneration; attempt++) {
      const a = rng() % TOT
      const ax = AX[a]
      const ay = AY[a]

      const dx = (rng() % RANGE) - mD
      let bx = ax + dx
      if (bx < 0) bx = 0
      else if (bx > nd) bx = nd
      const dy = (rng() % RANGE) - mD
      let by = ay + dy
      if (by < 0) by = 0
      else if (by > nd) by = nd
      const b = bx + by * sd
      if (b === a) continue

      const sa = CS[a]
      const sb = CS[b]

      // cost of cell A placed at slot B
      const sbx = bx - SRCX[sa]
      const sby = by - SRCY[sa]
      const spAonB = sbx * sbx + sby * sby
      const crA = CR[a] - TR[b]
      const cgA = CG[a] - TG[b]
      const cbA = CB[a] - TB[b]
      const colAonB = crA * crA + cgA * cgA + cbA * cbA
      const costAonB = colAonB * WW[b] + spAonB * spAonB * prox2

      // cost of cell B placed at slot A
      const sax = ax - SRCX[sb]
      const say = ay - SRCY[sb]
      const spBonA = sax * sax + say * say
      const crB = CR[b] - TR[a]
      const cgB = CG[b] - TG[a]
      const cbB = CB[b] - TB[a]
      const colBonA = crB * crB + cgB * cgB + cbB * cbB
      const costBonA = colBonA * WW[a] + spBonA * spBonA * prox2

      if (costAonB + costBonA < HH[a] + HH[b]) {
        // swap cells a <-> b
        const tR = CR[a]
        const tG = CG[a]
        const tB = CB[a]
        CR[a] = CR[b]
        CG[a] = CG[b]
        CB[a] = CB[b]
        CR[b] = tR
        CG[b] = tG
        CB[b] = tB
        const ts = CS[a]
        CS[a] = CS[b]
        CS[b] = ts
        HH[a] = costAonB
        HH[b] = costBonA
        swapsMade++
        genSwapA.push(a)
        genSwapB.push(b)
      }
    }

    totalSwaps += swapsMade
    const progress = 1 - maxDist / sd
    const swaps: FrameSwaps | null = genSwapA.length ? { a: genSwapA, b: genSwapB } : null
    onFrame?.(generation, progress, swaps, render())

    if (maxDist < minSearchRadius && swapsMade < 10) break
    if (swapsMade === 0) {
      stale++
      if (stale >= 40 && maxDist <= minSearchRadius * 2) break
    } else {
      stale = 0
    }
    maxDist = Math.max(2, (maxDist * 0.99) | 0)
  }

  let endCost = 0
  for (let i = 0; i < N; i++) endCost += h[i]

  return {
    output: render(),
    generations: generation,
    swaps: totalSwaps,
    startCost,
    endCost,
  }
}