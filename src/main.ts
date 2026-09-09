import './style.css'
import targetUrl from './assets/target.png'
import weightsUrl from './assets/weights.png'
import { squareCropResizeToRgba } from './imageutil'
import type { ImageDataLike } from './imageutil'
import type { GifOptions } from './worker'
import { makeFilmClock, type FilmClock } from './filmplayback'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const fileInput = $<HTMLInputElement>('file')
const dropzone = $<HTMLElement>('dropzone')
const previewBox = $<HTMLElement>('previewBox')
const sourcePreview = $<HTMLImageElement>('sourcePreview')
const changePhoto = $<HTMLButtonElement>('changePhoto')
const controls = $<HTMLElement>('controls')
const resolutionSel = $<HTMLSelectElement>('resolution')
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
const menuBtn = $<HTMLButtonElement>('menuBtn')
const menuPanel = $<HTMLElement>('menuPanel')
const menuBackdrop = $<HTMLElement>('menuBackdrop')
const installBtn = $<HTMLButtonElement>('installBtn')

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let sourceBitmap: (CanvasImageSource & { width: number; height: number }) | null = null
let previewUrl: string | null = null

// canonical 256x256 target + weights, decoded once
let target256: ImageDataLike | null = null
let weights256: ImageDataLike | null = null

// resized copies per sidelen, so we can reuse across runs
const targetCache = new Map<number, ImageDataLike>()
const weightsCache = new Map<number, ImageDataLike>()

let worker: Worker | null = null
let queuedJobId = 0
let currentJobId = -1
let jobStartMs = 0
let lastResult: ImageDataLike | null = null
let currentSidelen = 96

// recorded morph frames for the post-run animation
let animFrames: Uint8ClampedArray[] = []
let film: FilmClock | null = null
let animPlaying = false
let animReverse = false
let animTimer: ReturnType<typeof setTimeout> | null = null
const HOLD_MS = 700
const ANIM_FRAME_MS = 42
const ANIM_MAX_FRAMES = 360

const GIF_OPTIONS: GifOptions = { delayMs: 60, maxFrames: 160, colors: 192 }

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
        recordAnimFrame(f.data)
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
    if (currentJobId === -1) return
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
  // `img` is already transfer-owned by this thread; keep the reference, no copy.
  animFrames.push(img)
  if (animFrames.length > ANIM_MAX_FRAMES * 2) compressAnimFrames()
}

function compressAnimFrames() {
  if (animFrames.length <= ANIM_MAX_FRAMES) return
  const stride = Math.ceil(animFrames.length / ANIM_MAX_FRAMES)
  const next: Uint8ClampedArray[] = []
  for (let i = 0; i < animFrames.length; i += stride) next.push(animFrames[i])
  // the film stops on its last frame — always keep the exact final Gandhi
  if (next[next.length - 1] !== animFrames[animFrames.length - 1]) {
    next.push(animFrames[animFrames.length - 1])
  }
  animFrames = next
}

function startAnim() {
  if (animFrames.length < 2 || !film) return
  animPlaying = true
  playAnimBtn.textContent = 'pause animation'
  film.setReverse(animReverse)
  const start = film.begin()
  const frame = animFrames[start.frame]
  if (frame) drawOn(resultCanvas, frame, currentSidelen, false)
  scheduleTick()
}

function stopAnim() {
  animPlaying = false
  film?.pause()
  playAnimBtn.textContent = 'play animation'
  if (animTimer !== null) {
    clearTimeout(animTimer)
    animTimer = null
  }
}

function resetAnim() {
  stopAnim()
  animFrames = []
  film = null
  animReverse = false
  reverseAnimBtn.classList.remove('on')
  reverseAnimBtn.setAttribute('aria-pressed', 'false')
}

function scheduleTick() {
  animTimer = setTimeout(() => {
    animTimer = null
    if (!animPlaying || !film) return
    const step = film.tick()
    const frame = animFrames[step.frame]
    if (frame) drawOn(resultCanvas, frame, currentSidelen, false)
    if (step.running) {
      scheduleTick()
    } else {
      // the film reached the final Gandhi (or the source, reversed): stop here
      animPlaying = false
      playAnimBtn.textContent = 'play animation'
    }
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
  if (!lastResult) return
  showStage('done')
  drawOn(resultCanvas, lastResult.data, lastResult.width)
  setProgress(100)

  // replayable animation of the whole solve (incl. the original photo)
  compressAnimFrames()
  playAnimBtn.disabled = animFrames.length < 2
  film = makeFilmClock({
    frameCount: animFrames.length,
    holdMs: HOLD_MS,
    frameMs: ANIM_FRAME_MS,
  })
  const reduceMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!reduceMotion) startAnim()

  // downloads
  downloadPng.disabled = false
  downloadGif.dataset.gif = d.gifBytes ? encodeGifDataUrl(d.gifBytes) : ''
  downloadGif.disabled = !d.gifBytes

  // mobile sharing
  shareBtn.hidden = typeof navigator.share !== 'function'

  const elapsed = Math.max(0, (performance.now() - jobStartMs) / 1000)
  stats.textContent = `finished in ${elapsed.toFixed(1)}s after ${d.generations} generations (${d.swaps.toLocaleString()} swaps) · proximity 6`
}

// gif datastore in a data url (small enough to keep in memory)
function encodeGifDataUrl(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return 'data:image/gif;base64,' + btoa(binary)
}

function onDownloadPng() {
  if (!lastResult) return
  // export the FINAL result, never whatever frame the film is paused on
  const canvas = document.createElement('canvas')
  canvas.width = lastResult.width
  canvas.height = lastResult.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  ctx.putImageData(new ImageData(lastResult.data as Uint8ClampedArray<ArrayBuffer>, lastResult.width, lastResult.height), 0, 0)
  canvas.toBlob((blob) => {
    if (blob) triggerDownload(blob, 'gandhified.png')
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
  const pngBlob = await new Promise<Blob | null>((resolve) => {
    const canvas = document.createElement('canvas')
    canvas.width = lastResult!.width
    canvas.height = lastResult!.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return resolve(null)
    ctx.putImageData(
      new ImageData(lastResult!.data as Uint8ClampedArray<ArrayBuffer>, lastResult!.width, lastResult!.height),
      0,
      0,
    )
    canvas.toBlob(resolve, 'image/png')
  })
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
  if (!sourceBitmap) {
    showError('pick a photo first')
    return
  }
  if (!target256 || !weights256) {
    showError('the Gandhi assets are still loading — give it a second and try again')
    return
  }
  clearError()

  const sidelen = Number(resolutionSel.value)

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
  jobStartMs = performance.now()
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
        proximityImportance: 6,
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
    releaseSourceBitmap()
    releasePreviewUrl()
    sourceBitmap = bitmap
    previewUrl = URL.createObjectURL(file)
    sourcePreview.src = previewUrl
    showStage('picked')
    clearError()
  } catch (err) {
    showError('could not read that image: ' + (err instanceof Error ? err.message : String(err)))
  }
}

function releaseSourceBitmap() {
  if (sourceBitmap) {
    const bitmap = sourceBitmap as ImageBitmap
    if (typeof bitmap.close === 'function') bitmap.close()
  }
  sourceBitmap = null
}

function releasePreviewUrl() {
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl)
    previewUrl = null
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
  releaseSourceBitmap()
  releasePreviewUrl()
  sourcePreview.src = ''
  showStage('idle')
  resetAnim()
})

goBtn.addEventListener('click', () => runJob())

cancelBtn.addEventListener('click', () => {
  killWorker()
  setProgress(0)
  showStage('picked')
  resetAnim()
})

againBtn.addEventListener('click', () => {
  releaseSourceBitmap()
  releasePreviewUrl()
  sourcePreview.src = ''
  lastResult = null
  showStage('idle')
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
  film?.setReverse(animReverse)
  reverseAnimBtn.classList.toggle('on', animReverse)
  reverseAnimBtn.setAttribute('aria-pressed', String(animReverse))
})

// ---------------------------------------------------------------------------
// ⋯ menu
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function setMenu(open: boolean) {
  menuBtn.setAttribute('aria-expanded', String(open))
  menuPanel.hidden = !open
  menuBackdrop.hidden = !open
}

menuBtn.addEventListener('click', () => setMenu(menuPanel.hidden))
menuBackdrop.addEventListener('click', () => setMenu(false))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false)
})

// ---------------------------------------------------------------------------
// install (PWA)
// ---------------------------------------------------------------------------

let deferredPrompt: BeforeInstallPromptEvent | null = null

const isStandalone =
  typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches

function syncInstallBtn() {
  const show = !deferredPrompt && !isStandalone
  installBtn.hidden = !show
  // hide the ⋯ button too, so we never show an empty/dead menu
  menuBtn.hidden = !show
}

window.addEventListener(
  'beforeinstallprompt',
  ((e: Event) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    syncInstallBtn()
  }) as EventListener,
)

window.addEventListener(
  'appinstalled',
  (() => {
    deferredPrompt = null
    syncInstallBtn()
  }) as EventListener,
)

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return
  const prompt = deferredPrompt
  deferredPrompt = null
  try {
    await prompt.prompt()
    await prompt.userChoice
  } catch {
    /* user dismissed */
  }
  syncInstallBtn()
})

// hide the ⋯ menu up front unless/until the app is installable
syncInstallBtn()

// ---------------------------------------------------------------------------
// PWA offline shell
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

void preloadAssets()

// keep initial canvases in sync with default resolution
morphCanvas.width = 96
morphCanvas.height = 96
resultCanvas.width = 96
resultCanvas.height = 96

// debug hook for the e2e harness: ?debug in the URL exposes the film state
if (new URLSearchParams(location.search).has('debug')) {
  ;(window as unknown as Record<string, unknown>).__morphDebug = () => ({
    playing: animPlaying,
    len: animFrames.length,
    index: film ? film.index : -1,
    hold: film ? film.hold : 0,
    running: film ? film.running : false,
  })
}