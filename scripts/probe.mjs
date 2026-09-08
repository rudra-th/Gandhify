import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const APP_PORT = 5355
const PORT = 9357
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const preview = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore' },
)
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/`)
    if (r.ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 250))
}

const p = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'probe-'))}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `http://127.0.0.1:${APP_PORT}/`,
  ],
  { stdio: 'ignore' },
)
setTimeout(() => {
  console.log('PROBE TIMEOUT')
  p.kill()
  preview.kill()
  process.exit(2)
}, 30000)
try {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id) {
      pending.get(m.id)?.(m)
      pending.delete(m.id)
    }
  }
const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++id
      const timer = setTimeout(() => {
        pending.delete(i)
        rej(new Error('timeout ' + method))
      }, 5000)
      pending.set(i, (m) => {
        clearTimeout(timer)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  const ev = (expression, opts = {}) =>
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts }).then((r) => r.result.value)

  console.log('1+1 =', await ev('1+1'))
  console.log('readyState =', await ev('document.readyState'))
  console.log('dropzone =', await ev("!!document.getElementById('dropzone')"))
  console.log('dropzone hidden =', await ev('document.getElementById("dropzone").hidden'))
  console.log('error el =', await ev("!!document.getElementById('app-error')"))
  console.log('hook =', await ev(`window.__errs=[]; window.addEventListener('error',(e)=>window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection',(e)=>window.__errs.push(String(e.reason?.message||e.reason)));'ok'`))
  console.log('after =', await ev('1+1'))
  process.exit(0)
} catch (e) {
  console.error('ERR', e.message)
  process.exit(1)
} finally {
  p.kill()
  preview.kill()
}