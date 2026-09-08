import './style.css'
import targetUrl from './assets/target.png'
import weightsUrl from './assets/weights.png'
import { squareCropResizeToRgba } from './imageutil'
import type { ImageDataLike } from './imageutil'
import type { GifOptions } from './worker'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const fileInput = $<HTMLInputElement>('file')
const dropzone = $<HTMLElement>('dropzone')
const previewBox = $<HTMLElement>('previewBox')
const sourcePreview = $<HTMLImageElement>('sourcePreview')
const changePhoto = $<HTMLButtonElement>('changePhoto')
const controls = $<HTMLElement>('controls')
const resolutionSel = $<HTMLSelectElement>('resolution')
const subtlety = $<HTMLInputElement>('subtlety')
const subtletyOut = $<HTMLOutputElement>('subtletyOut')
const goBtn = $<HTMLButtonElement>('go')
const progressBox = $<HTMLElement>('progressBox')
const progressLabel = $<HTMLElement>('progressLabel')
const progressPct = $<HTMLElement>('progressPct')
const barFill = $<HTMLElement>('barFill')
const morphCanvas = $<HTMLCanvasElement>('morph')
const cancelBtn = $<HTMLButtonElement>('cancel')
const resultBox = $<HTMLElement>('result')
const resultCanvas = $<HTMLCanvasElement>('resultCanvas')
const downloadPng = $<HTMLButtonElement>('downloadPng')
const downloadGif = $<HTMLButtonElement>('downloadGif')
const shareBtn = $<HTMLButtonElement>('share')
const againBtn = $<HTMLButtonElement>('again')
const playAnimBtn = $<HTMLButtonElement>('playAnim')
const reverseAnimBtn = $<HTMLButtonElement>('reverseAnim')
const stats = $<HTMLElement>('stats')
const appError = $<HTMLElement>('app-error')

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let sourceBitmap: (CanvasImageSource & { width: number; height: number }) | null = null

// canonical 256x256 target + weights, decoded once
let target256: ImageDataLike | null = null
let weights256: ImageDataLike | null = null

// resized copies per sidelen, so we can reuse across runs
const targetCache = new Map<number, ImageDataLike>()
const weightsCache = new Map<number, ImageDataLike>()

let worker: Worker | null = null
let queuedJobId = 0
let currentJobId = -1
let lastResult: ImageDataLike | null = null
let currentSidelen = 96

// recorded morph frames for the post-run animation
let animFrames: Uint8ClampedArray[] = []
let animIndex = 0
let animPlaying = false
let animReverse = false
let animTimer: ReturnType<typeof setTimeout> | null = null
const ANIM_FRAME_MS = 45
const ANIM_MAX_FRAMES = 320

const GIF_OPTIONS: GifOptions = { delayMs: 55, maxFrames: 140, colors: 192 }

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function showError(message: string) {
  appError.textContent = message
  appError.hidden = false
}

function clearError() {
  appError.hidden = true
  appError.textContent = ''
}

function setProgress(pct: number, label?: string) {
  const clamped = Math.max(0, Math.min(100, pct))
  barFill.style.width = `${clamped}%`
  progressPct.textContent = `${clamped.toFixed(0)}%`
  if (label) progressLabel.textContent = label
}

function showStage(which: 'idle' | 'picked' | 'running' | 'done') {
  const idle = dropzone
  const picked = previewBox
  const run = progressBox
  const done = resultBox
  const ctrl = controls

  switch (which) {
    case 'idle':
      idle.hidden = false
      picked.hidden = true
      ctrl.hidden = true
      run.hidden = true
      done.hidden = true
      break
    case 'picked':
      idle.hidden = true
      picked.hidden = false
      ctrl.hidden = false
      run.hidden = true
      done.hidden = true
      break
    case 'running':
      idle.hidden = true
      picked.hidden = true
      ctrl.hidden = true
      run.hidden = false
      done.hidden = true
      break
    case 'done':
      idle.hidden = true
      picked.hidden = true
      ctrl.hidden = true
      run.hidden = true
      done.hidden = false
      break
  }
}

// ---------------------------------------------------------------------------
// asset loading
// ---------------------------------------------------------------------------

async function preloadAssets() {
  try {
    const [targetBlob, weightsBlob] = await Promise.all([
      (await fetch(targetUrl)).blob(),
      (await fetch(weightsUrl)).blob(),
    ])
    const [target, weights] = await Promise.all([
      createImageBitmap(targetBlob),
      createImageBitmap(weightsBlob),
    ])
    target256 = squareCropResizeToRgba(target, 256)
    weights256 = squareCropResizeToRgba(weights, 256)
    target.close()
    weights.close()
  } catch (err) {
    showError(
      'could not load the Gandhi portrait assets: ' +
        (err instanceof Error ? err.message : String(err)),
    )
  }
}

function getResizedTarget(sidelen: number): ImageDataLike {
  let t = targetCache.get(sidelen)
  if (!t && target256) {
    t = squareCropResizeToRgba(target256, sidelen)
    targetCache.set(sidelen, t)
  }
  if (!t) throw new Error('target assets not ready')
  return t
}

function getResizedWeights(sidelen: number): ImageDataLike {
  let w = weightsCache.get(sidelen)
  if (!w && weights256) {
    w = squareCropResizeToRgba(weights256, sidelen)
    weightsCache.set(sidelen, w)
  }
  if (!w) throw new Error('weights assets not ready')
  return w
}

// ---------------------------------------------------------------------------
// worker plumbing
// ---------------------------------------------------------------------------

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { type: string; id: number }
    if (msg.id !== currentJobId) return
    switch (msg.type) {
      case 'frame': {
        const f = msg as FrameRetort
        currentSidelen = f.side
        drawOn(morphCanvas, f.data, f.side)
        recordAnimFrame(f.data.slice(0))
        setProgress(f.progress * 100, `generation ${f.generation}`)
        break
      }
      case 'done': {
        const d = msg as DoneRetort
        finishJob(d)
        break
      }
      case 'error': {
        const e = msg as ErrorRetort
        setProgress(0)
        showStage('picked')
        showError('something went wrong: ' + e.message)
        break
      }
    }
  }
  worker.onerror = (event) => {
    setProgress(0)
    showStage('picked')
    showError('the worker failed: ' + event.message)
  }
  return worker
}

// ---------------------------------------------------------------------------
// morph film (post-run animation on the result canvas)
// ---------------------------------------------------------------------------

function recordAnimFrame(img: Uint8ClampedArray) {
  animFrames.push(img)
  if (animFrames.length > ANIM_MAX_FRAMES * 2) compressAnimFrames()
}

function compressAnimFrames() {
  if (animFrames.length <= ANIM_MAX_FRAMES) return
  const stride = Math.ceil(animFrames.length / ANIM_MAX_FRAMES)
  const next: Uint8ClampedArray[] = []
  for (let i = 0; i < animFrames.length; i += stride) next.push(animFrames[i])
  animFrames = next
}

function startAnim() {
  if (animFrames.length < 2) return
  animPlaying = true
  playAnimBtn.textContent = 'pause animation'
  scheduleTick()
}

function stopAnim() {
  animPlaying = false
  playAnimBtn.textContent = 'play animation'
  if (animTimer !== null) {
    clearTimeout(animTimer)
    animTimer = null
  }
}

function resetAnim() {
  stopAnim()
  animFrames = []
  animIndex = 0
  animReverse = false
  reverseAnimBtn.classList.remove('on')
  reverseAnimBtn.setAttribute('aria-pressed', 'false')
}

function scheduleTick() {
  animTimer = setTimeout(() => {
    animTimer = null
    if (!animPlaying) return
    animIndex += animReverse ? -1 : 1
    if (animIndex < 0) animIndex = animFrames.length - 1
    else if (animIndex >= animFrames.length) animIndex = 0
    const frame = animFrames[animIndex]
    if (frame) drawOn(resultCanvas, frame, currentSidelen, false)
    scheduleTick()
  }, ANIM_FRAME_MS)
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

function drawOn(canvas: HTMLCanvasElement, data: Uint8ClampedArray, sidelen: number, updateLast = true) {
  if (canvas.width !== sidelen || canvas.height !== sidelen) {
    canvas.width = sidelen
    canvas.height = sidelen
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, sidelen, sidelen), 0, 0)
  if (updateLast) lastResult = { width: sidelen, height: sidelen, data: data.slice(0) }
}

function finishJob(d: DoneRetort) {
  showStage('done')
  if (!lastResult) return
  drawOn(resultCanvas, lastResult.data, lastResult.width)
  setProgress(100)

  // replayable animation of the whole solve (incl. the original photo)
  compressAnimFrames()
  animIndex = -1
  playAnimBtn.disabled = animFrames.length < 2
  startAnim()

  // downloads
  downloadPng.disabled = false
  downloadGif.dataset.gif = d.gifBytes ? encodeGifDataUrl(d.gifBytes) : ''
  downloadGif.disabled = !d.gifBytes

  // mobile sharing
  const canShare = typeof navigator.share === 'function'
  shareBtn.hidden = !canShare

  const prox = Number(subtlety.value)
  stats.textContent = `finished in ${(performance.now() / 1000).toFixed(0)}s after ${d.generations} generations (${d.swaps.toLocaleString()} swaps) · proximity ${prox}`
}

// gif datastore in a data url (small enough to keep in memory)
function encodeGifDataUrl(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return 'data:image/gif;base64,' + btoa(binary)
}

function onDownloadPng() {
  if (!lastResult) return
  resultCanvas.toBlob((blob) => {
    if (!blob) return
    triggerDownload(blob, 'gandhified.png')
  }, 'image/png')
}

function onDownloadGif() {
  const dataUrl = downloadGif.dataset.gif
  if (!dataUrl) return
  fetch(dataUrl)
    .then((r) => r.blob())
    .then((blob) => triggerDownload(blob, 'gandhified.gif'))
    .catch(() => {
      const bytes = dataUrlToBytes(dataUrl)
      triggerDownload(
        new Blob([bytes], { type: 'image/gif' }),
        'gandhified.gif',
      )
    })
}

function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const [, b64] = dataUrl.split(',')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

async function onShare() {
  if (!lastResult) return
  const pngBlob = await new Promise<Blob | null>((resolve) =>
    resultCanvas.toBlob(resolve, 'image/png'),
  )
  const gifData = downloadGif.dataset.gif
  const gifBlob = gifData ? new Blob([dataUrlToBytes(gifData)], { type: 'image/gif' }) : null
  const files: File[] = []
  if (pngBlob) files.push(new File([pngBlob], 'gandhified.png', { type: 'image/png' }))
  if (gifBlob) files.push(new File([gifBlob], 'gandhified.gif', { type: 'image/gif' }))
  if (files.length === 0) return
  try {
    if (navigator.canShare && !navigator.canShare({ files })) return
    await navigator.share({ files, title: 'Gandhify', text: 'made with Gandhify' })
  } catch {
    /* user cancelled or sharing unsupported */
  }
}

// ---------------------------------------------------------------------------
// job runner
// ---------------------------------------------------------------------------

function runJob() {
  if (!sourceBitmap || !target256 || !weights256) return
  clearError()

  const sidelen = Number(resolutionSel.value)
  const prox = Number(subtlety.value)

  let sourceRgba: ImageDataLike
  try {
    sourceRgba = squareCropResizeToRgba(sourceBitmap, sidelen)
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    return
  }

  let targetRgba: ImageDataLike
  let weightsRgba: ImageDataLike
  try {
    targetRgba = getResizedTarget(sidelen)
    weightsRgba = getResizedWeights(sidelen)
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
    return
  }

  const id = ++queuedJobId
  currentJobId = id
  lastResult = null
  currentSidelen = sidelen
  resetAnim()
  setProgress(0, 'preparing…')

  const w = ensureWorker()
  w.postMessage(
    {
      id,
      source: sourceRgba,
      target: targetRgba,
      weights: weightsRgba,
      settings: {
        sidelen,
        proximityImportance: prox,
        maxGenerations: 900,
      },
      gif: GIF_OPTIONS,
    },
    { transfer: [sourceRgba.data.buffer] },
  )
}

function killWorker() {
  if (worker) {
    worker.terminate()
    worker = null
  }
  currentJobId = -1
}

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

async function handleFiles(files: FileList | File[]) {
  const file = Array.from(files).find((f) => f.type.startsWith('image/'))
  if (!file) return
  try {
    const bitmap = await createImageBitmap(file)
    sourceBitmap = bitmap
    sourcePreview.src = URL.createObjectURL(file)
    showStage('picked')
    clearError()
  } catch (err) {
    showError('could not read that image: ' + (err instanceof Error ? err.message : String(err)))
  }
}

fileInput.addEventListener('change', () => {
  if (fileInput.files) void handleFiles(fileInput.files)
})

dropzone.addEventListener('click', () => fileInput.click())
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fileInput.click()
  }
})

for (const evt of ['dragenter', 'dragover']) {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
}
for (const evt of ['dragleave', 'drop']) {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
  })
}
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files) void handleFiles(e.dataTransfer.files)
})

changePhoto.addEventListener('click', () => {
  showStage('idle')
  sourceBitmap = null
  sourcePreview.src = ''
  resetAnim()
})

subtlety.addEventListener('input', () => {
  subtletyOut.textContent = subtlety.value
})

goBtn.addEventListener('click', () => runJob())

cancelBtn.addEventListener('click', () => {
  killWorker()
  setProgress(0)
  showStage('picked')
  resetAnim()
})

againBtn.addEventListener('click', () => {
  showStage('idle')
  sourceBitmap = null
  sourcePreview.src = ''
  lastResult = null
  resetAnim()
})

downloadPng.addEventListener('click', onDownloadPng)
downloadGif.addEventListener('click', onDownloadGif)
shareBtn.addEventListener('click', () => void onShare())

playAnimBtn.addEventListener('click', () => {
  if (animPlaying) stopAnim()
  else startAnim()
})

reverseAnimBtn.addEventListener('click', () => {
  animReverse = !animReverse
  reverseAnimBtn.classList.toggle('on', animReverse)
  reverseAnimBtn.setAttribute('aria-pressed', String(animReverse))
})

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

void preloadAssets()

// keep initial canvases in sync with default resolution
morphCanvas.width = 96
morphCanvas.height = 96
resultCanvas.width = 96
resultCanvas.height = 96