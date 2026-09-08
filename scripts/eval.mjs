// Headless evaluation of the Gandhify solver.
//
//   node scripts/eval.mjs <source.png> [--sidelen 96] [--prox 13] [--out dir]
//
// Decodes PNG sources, runs the exact browser solver (imported as TS on
// Node 24's native type-stripping), writes the output PNG and prints
// objective quality metrics so weight parameters can be tuned without a
// browser.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { solve } from '../src/solver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = resolve(HERE, '../src/assets/target.png')
const WEIGHTS = resolve(HERE, '../src/assets/weights.png')

function loadPng(path) {
  const png = PNG.sync.read(readFileSync(path))
  return { width: png.width, height: png.height, data: png.data }
}

function centerCropResize(img, sidelen) {
  const { width, height, data } = img
  const side = Math.min(width, height)
  const sx0 = Math.floor((width - side) / 2)
  const sy0 = Math.floor((height - side) / 2)
  const out = new Uint8ClampedArray(sidelen * sidelen * 4)
  for (let y = 0; y < sidelen; y++) {
    const sy = sy0 + (y * side) / sidelen
    for (let x = 0; x < sidelen; x++) {
      const sx = sx0 + (x * side) / sidelen
      const ix = Math.min(side - 1, Math.floor(sx))
      const iy = Math.min(side - 1, Math.floor(sy))
      const i0 = (iy * width + ix) * 4
      const o0 = (y * sidelen + x) * 4
      out[o0] = data[i0]
      out[o0 + 1] = data[i0 + 1]
      out[o0 + 2] = data[i0 + 2]
      out[o0 + 3] = 255
    }
  }
  return { width: sidelen, height: sidelen, data: out }
}

function pearson(a, b) {
  let ma = 0, mb = 0
  const n = a.length
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb
    num += x * y; da += x * x; db += y * y
  }
  const den = Math.sqrt(da * db)
  return den === 0 ? 0 : num / den
}

function luminance(img) {
  const n = img.width * img.height
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    out[i] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
  }
  return out
}

const ASCII = ' .:-=+*#%@'

function asciify(img, cols = 48) {
  const lum = luminance(img)
  const rows = Math.round((cols * img.height) / img.width)
  let out = ''
  for (let r = 0; r < rows; r++) {
    let line = ''
    const yy = (r * img.height) / rows
    for (let c = 0; c < cols; c++) {
      const xx = (c * img.width) / cols
      const i = Math.min(lum.length - 1, (Math.floor(yy) * img.width + Math.floor(xx)))
      const v = lum[i] / 255
      line += ASCII[Math.min(ASCII.length - 1, Math.floor(v * (ASCII.length - 1)))]
    }
    out += line + '\n'
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const srcArg = args.find((a) => !a.startsWith('--'))
  if (!srcArg) {
    console.error('usage: node scripts/eval.mjs <source.png> [--sidelen N] [--prox P] [--out DIR]')
    process.exit(1)
  }
  const get = (name, def) => {
    const i = args.indexOf('--' + name)
    return i >= 0 ? args[i + 1] : def
  }
  const sidelen = Number(get('sidelen', 96))
  const prox = Number(get('prox', 13))
  const swapsPerPixel = Number(get('swaps', 128))
  const outDir = resolve(HERE, get('out', 'out'))

  const source = centerCropResize(loadPng(resolve(srcArg)), sidelen)
  const target = centerCropResize(loadPng(TARGET), sidelen)
  const weights = centerCropResize(loadPng(WEIGHTS), sidelen)

  const t0 = performance.now()
  const result = solve({
    source,
    target,
    weights,
    settings: {
      sidelen,
      proximityImportance: prox,
      maxGenerations: 900,
      swapsPerPixelPerGeneration: swapsPerPixel,
    },
  })
  const ms = performance.now() - t0

  const outImg = { width: sidelen, height: sidelen, data: result.output }
  const srcLum = luminance(source)
  const tgtLum = luminance(target)
  const outLum = luminance(outImg)

  const W = weights.data
  let ec = 0
  const n = sidelen * sidelen
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const dr = outImg.data[o] - target.data[o]
    const dg = outImg.data[o + 1] - target.data[o + 1]
    const db = outImg.data[o + 2] - target.data[o + 2]
    ec += (dr * dr + dg * dg + db * db) * W[o]
  }
  const corrTarget = pearson(outLum, tgtLum)
  const corrSource = pearson(outLum, srcLum)

  // face-restricted correlations: what really matters for 'reads as Gandhi'
  const faceMask = new Uint8Array(n)
  let faceCount = 0
  for (let i = 0; i < n; i++) {
    if (W[i * 4] >= 180) {
      faceMask[i] = 1
      faceCount++
    }
  }
  const pick = (arr) => {
    const out = new Float64Array(faceCount)
    let k = 0
    for (let i = 0; i < n; i++) if (faceMask[i]) out[k++] = arr[i]
    return out
  }
  const corrTargetFace = faceCount
    ? pearson(pick(outLum), pick(tgtLum))
    : 0
  const corrSourceFace = faceCount ? pearson(pick(outLum), pick(srcLum)) : 0

  const name = resolve(srcArg).split(/[\\/]/).pop().replace(/\.png$/i, '')
  const outPath = resolve(outDir, `${name}_s${sidelen}_p${prox}.png`)
  mkdirSync(outDir, { recursive: true })
  const withAlpha = Buffer.alloc(sidelen * sidelen * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    withAlpha[o] = outImg.data[o]
    withAlpha[o + 1] = outImg.data[o + 1]
    withAlpha[o + 2] = outImg.data[o + 2]
    withAlpha[o + 3] = 255
  }
  writeFileSync(outPath, PNG.sync.write({ colorType: 6, width: sidelen, height: sidelen, data: withAlpha }))

  if (get('ascii', '1') === '1') {
    console.log('\n--- weights ---\n' + asciify(weights))
    console.log('--- target ---\n' + asciify(target))
    console.log('--- source ---\n' + asciify(source))
    console.log('--- output ---\n' + asciify(outImg))
  }

  console.log(JSON.stringify({
    source: name,
    sidelen,
    prox,
    ms: Math.round(ms),
    generations: result.generations,
    swaps: result.swaps,
    meanColorErr: (ec / n).toFixed(1), // mean weighted color distance^2
    corrTarget: corrTarget.toFixed(3),     // output structurally matches target
    corrSource: corrSource.toFixed(3),     // output retains original content
    corrTargetFace: corrTargetFace.toFixed(3),
    corrSourceFace: corrSourceFace.toFixed(3),
    out: outPath,
  }, null, 2))
}

main()