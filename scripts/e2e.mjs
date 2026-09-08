// Headless-browser end-to-end check: boots the built app in headless Chrome
// via CDP, uploads einstein.png through the real file input, runs the worker
// solve to completion, and verifies the whole pipeline (incl. the ImageData
// code that previously crashed with IndexSizeError) plus the animation.
// Usage: node scripts/e2e.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const APP_PORT = 5321 + (process.pid % 50)
const CDP_PORT = 9320 + (process.pid % 300)
const HEADED = process.env.E2E_HEADED !== '0'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const B64 = readFileSync(resolve(HERE, 'sources/einstein.png'), 'base64')

let chromeProc = null
let preview = null
let ws = null

try {
  console.log('APP_PORT', APP_PORT, 'CDP_PORT', CDP_PORT)

  // 1. serve the built app
  preview = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  preview.stdout.on('data', (d) => process.stdout.write('[preview] ' + d))
  preview.stderr.on('data', (d) => process.stdout.write('[preview:err] ' + d))
  preview.on('error', (e) => console.log('[preview:spawn-error]', e.code, e.message))
  await waitFor(() => isUp(`http://127.0.0.1:${APP_PORT}/`), 20000, 'vite preview did not come up')
  console.log('app is up')

  // 2. headless chrome (fresh profile, unique CDP port, app URL preloaded)
  const profileDir = mkdtempSync(join(tmpdir(), 'gandhify-e2e-'))
  chromeProc = spawn(
    CHROME,
    [
      HEADED ? '' : '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window'.slice(0, 0), // keep flags tidy
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      `http://127.0.0.1:${APP_PORT}/`,
    ].filter(Boolean),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  chromeProc.on('error', (e) => console.log('[chrome:spawn-error]', e.code, e.message))
  chromeProc.stderr.on('data', (d) => process.stdout.write('[chrome] ' + d))
  chromeProc.on('exit', (c, s) => console.log(`[chrome] exited code=${c} sig=${s}`))
  await waitFor(() => isUp(`http://127.0.0.1:${CDP_PORT}/json/version`), 20000, 'chrome CDP did not come up')
  console.log('chrome CDP up')

  // 3. attach to a page target
  await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
    return list.some((t) => t.type === 'page')
  }, 10000, 'no page target')
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  const events = []
  let nextId = 0
  const t0run = Date.now()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      }
    } else {
      events.push({ ts: Date.now() - t0run, ...msg })
    }
  }
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        const recent = events.slice(-8).map((e) => `+${e.ts} ${e.method}${e.params?.exceptionDetails ? ' (EXC)' : ''}`)
        const navs = events.filter((e) => e.method.startsWith('Page.') || e.method === 'Runtime.executionContextDestroyed')
        rej(new Error(`CDP timeout waiting for ${method} | recent: ${recent.join(' ; ')} | navs: ${navs.map((e) => `+${e.ts} ${e.method}${e.params?.frame?.url ? ' -> ' + e.params.frame.url.slice(0, 60) : ''}`).join(' ; ')}`))
      }, 20000)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          res(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rej(e)
        },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  console.log('cdp domains enabled')
  await waitFor(async () => (await evaluate('document.readyState')) === 'complete', 20000, 'page never loaded')
  await waitFor(async () => (await evaluate("!!document.getElementById('dropzone')")), 10000, 'dropzone missing')
  console.log('page loaded')

  // scrape CDP exceptions in the background
  const exceptions = []
  const poll = setInterval(() => {
    for (const ev of events) {
      if (ev.method === 'Runtime.exceptionThrown') {
        const t = JSON.stringify(ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text)
        if (!exceptions.includes(t)) exceptions.push(t)
      }
    }
  }, 250)

  // page-level error hook (mirrors the console crash reporter)
  await evaluate(`window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason?.message || e.reason)));'ok'`)
  console.log('error hook installed')

  // 4. upload through the real file input
  const upload = `(async () => {
    const dataUrl = 'data:image/png;base64,${B64}';
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'einstein.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return document.getElementById('previewBox').hidden === false;
  })()`
  await waitFor(async () => (await evaluate(upload)) === true, 15000, 'upload failed')
  console.log('upload done')
  await waitFor(async () => (await evaluate('document.getElementById("controls").hidden === false')), 10000, 'controls not shown')

  // 5. run the solve to completion
  const t0 = Date.now()
  await evaluate('document.getElementById("go").click()')
  await waitFor(
    async () => /finished in/.test(await evaluate('document.getElementById("stats").textContent')),
    90000,
    `solve timeout (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  )
  const statsText = await evaluate('document.getElementById("stats").textContent')

  // 6. animation should have auto-started and be moving the canvas
  const playLabel = await evaluate('document.getElementById("playAnim").textContent')
  const probe1 = await evaluate(`(() => {
    const c = document.getElementById('resultCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0, h = 0;
    for (let i = 0; i < d.length; i += 40) sum += d[i];
    for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) | 0;
    const mean = sum / (d.length / 40);
    let v = 0;
    for (let i = 0; i < d.length; i += 40) v += (d[i] - mean) ** 2;
    return { w: c.width, h: c.height, mean, span: v / (d.length / 40), hash: h };
  })()`)
  await sleep(700)
  const probe2 = await evaluate(`(() => {
    const c = document.getElementById('resultCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) | 0;
    return h;
  })()`)

  // 7. toggle reverse, confirm state
  await evaluate('document.getElementById("reverseAnim").click()')
  const reversePressed = await evaluate('document.getElementById("reverseAnim").getAttribute("aria-pressed")')

  // 7.5 ⋯ menu opens and closes (open before screenshot so it's visible)
  await evaluate('document.getElementById("menuBtn").click()')
  const menuOpen = await evaluate(
    '(!document.getElementById("menuPanel").hidden && document.getElementById("menuBtn").getAttribute("aria-expanded") === "true")',
  )

  // 8. screenshot for human eyeballing (menu left open)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(HERE, 'out/e2e-result.png'), Buffer.from(shot.data, 'base64'))

  await evaluate('document.getElementById("menuBackdrop").click()')
  const menuClosed = await evaluate('document.getElementById("menuPanel").hidden')
  const installVisible = await evaluate('!document.getElementById("installBtn").hidden')

  clearInterval(poll)
  const pageErrors = [...exceptions, ...(await evaluate('window.__errs'))]
  ws.close()
  const report = {
    solved: statsText.trim(),
    ms: Date.now() - t0,
    playLabel,
    canvas: probe1,
    animMoved: probe1.hash !== probe2,
    reversePressed,
    menuOpen,
    menuClosed,
    installVisible,
    pageErrors,
  }
  console.log(JSON.stringify(report, null, 2))
  const checks = []
  if (!/finished in/.test(statsText)) checks.push('solve did not finish')
  if (pageErrors.length) checks.push('page errors: ' + pageErrors.join(' | '))
  if (playLabel !== 'pause animation') checks.push('animation did not autoplay')
  if (!probe1.span || probe1.span === 0) checks.push('result canvas appears blank')
  if (probe1.hash === probe2) checks.push('animation did not advance the canvas')
  if (!menuOpen || !menuClosed) checks.push('⋯ menu did not open/close')
  if (checks.length) throw new Error(checks.join(' ; '))
  console.log('\nE2E OK — screenshot at scripts/out/e2e-result.png')
} catch (err) {
  console.error('E2E FAILED:')
  console.error(err?.stack || err)
  try {
    ws?.close()
  } catch {
    // ignore
  }
  process.exit(1)
} finally {
  if (chromeProc) {
    try {
      spawnSync('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // ignore
    }
  }
  if (preview) {
    try {
      preview.kill()
    } catch {
      // ignore
    }
  }
}

// ---- tiny helpers ----
async function isUp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    try {
      const host = url.includes('127.0.0.1') ? url.replace('127.0.0.1', 'localhost') : url
      const r = await fetch(host, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch {
      return false
    }
  }
}
async function waitFor(check, timeoutMs = 30000, label = 'timed out') {
  const t0 = Date.now()
  let last = false
  while (Date.now() - t0 < timeoutMs) {
    last = await check()
    if (last) return
    await sleep(250)
  }
  throw new Error(label + ' (last check: ' + last + ')')
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}