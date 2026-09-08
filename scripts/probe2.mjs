import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const APP_PORT = 5371
const PORT = 9582
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

// A page that mirrors what the app does at boot/upload WITHOUT any app JS
const pageUrl =
  'data:text/html,<html><body><canvas id="c"></canvas><script>' +
  'window.__ready=0;' +
  'async function go(){' +
  '  try{' +
  '    const target=await (await fetch("' + `http://127.0.0.1:${APP_PORT}/assets/target-Cqhy_NDe.png` + '")).blob();' +
  '    const bmp=await createImageBitmap(target);' +
  '    const c=document.getElementById("c");c.width=c.height=256;' +
  '    const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0);' +
  '    const id=ctx.getImageData(0,0,256,256);' +
  '    ctx.putImageData(id,0,0);' +
  '    window.__ready=id.data.length;' +
  '  }catch(e){window.__ready="ERR:"+e.message;}' +
  '}' +
  'go();' +
  '</script></body></html>'

const p = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'probe2-'))}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    pageUrl,
  ],
  { stdio: 'ignore' },
)
setTimeout(() => {
  console.log('PROBE2 TIMEOUT')
  p.kill()
  preview.kill()
  process.exit(2)
}, 40000)
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
      }, 8000)
      pending.set(i, (m) => {
        clearTimeout(timer)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable')
  const ev = (expression, opts = {}) =>
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts }).then((r) => r.result.value)

  console.log('__ready (t=0s) =', await ev('window.__ready'))
  await new Promise((r) => setTimeout(r, 1000))
  console.log('__ready (t=1s) =', await ev('window.__ready'))
  await new Promise((r) => setTimeout(r, 1000))
  console.log('1+1 =', await ev('1+1'))
  console.log('__ready (t=2s) =', await ev('window.__ready'))
  await new Promise((r) => setTimeout(r, 4000))
  console.log('__ready (t=6s) =', await ev('window.__ready'))
  console.log('PROBE2 OK')
  process.exit(0)
} catch (e) {
  console.error('PROBE2 ERR', e.message)
  process.exit(1)
} finally {
  p.kill()
  preview.kill()
}