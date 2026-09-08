import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const APP_PORT = 5377
const PORT = 9588
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const B64 = readFileSync(resolve(HERE, 'sources/einstein.png'), 'base64')

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
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'probe3-'))}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `http://127.0.0.1:${APP_PORT}/`,
  ],
  { stdio: 'ignore' },
)
setTimeout(() => {
  console.log('PROBE3 TIMEOUT')
  p.kill()
  preview.kill()
  process.exit(2)
}, 150000)
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
  const send = (method, params = {}) =>
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
  await send('Page.enable')
  await send('Log.enable')
  await send('Runtime.enable')
  const evalPlus = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
  const ev = evalPlus

  for (let i = 0; i < 20; i++) {
    const ok = await ev("!!document.getElementById('dropzone')")
    if (ok) break
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log('page ready')

  const upload = `(async () => {
    const dataUrl = 'data:image/png;base64,${B64}';
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'einstein.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return true;
  })()`
  console.log('upload =', await ev(upload))

  try {
    console.log('post-upload 1+1 =', await ev('1+1'))
  } catch (e) {
    console.log('post-upload 1+1 TIMEOUT:', e.message.slice(0, 60))
    try {
      await send('Runtime.terminateExecution')
      console.log('terminateExecution sent')
    } catch (e2) {
      console.log('terminate failed:', e2.message.slice(0, 60))
    }
    await new Promise((r) => setTimeout(r, 300))
    try {
      console.log('post-terminate 1+1 =', await ev('1+1'))
    } catch (e3) {
      console.log('post-terminate 1+1 TIMEOUT:', e3.message.slice(0, 60))
    }
    process.exit(0)
  }

  const t0 = Date.now()
  await ev(`(() => {
    window.__log = [];
    const s = document.getElementById('stats');
    const st = document.getElementById('progressLabel');
    new MutationObserver(() => window.__log.push('stats: ' + s.textContent)).observe(s, { childList: true, subtree: true, characterData: true });
    new MutationObserver(() => window.__log.push('status: ' + st.textContent)).observe(st, { childList: true, subtree: true, characterData: true });
    document.getElementById('go').click();
    return 'started';
  })()`)
  console.log('go clicked')

  let wedged = 0
  let lastLog = ''
  while (Date.now() - t0 < 90000) {
    const t = (Date.now() - t0) / 1000
    let alive = true
    try {
      await evalPlus('1+1')
      const tail = await evalPlus('window.__log.slice(-2).join(' + "' || '" + ')')
      if (tail !== lastLog) {
        lastLog = tail
        console.log(`+${t.toFixed(1)}s: ${tail}`)
      }
    } catch (e) {
      alive = false
      wedged = Math.round((Date.now() - t0) / 1000)
      console.log(`WEDGED? at +${wedged}s (${e.message.slice(0, 90)})`)
      try {
        await send('Runtime.terminateExecution')
        console.log('terminateExecution sent')
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
      try {
        console.log('after terminate 1+1 =', await evalPlus('1+1'))
      } catch (e2) {
        console.log('still wedged after terminate:', e2.message.slice(0, 60))
        break
      }
      break
    }
    if (!alive) break
    await new Promise((r) => setTimeout(r, 400))
  }
  const done = await evalPlus("document.getElementById('stats').textContent")
  console.log(`PROBE3 DONE (t=${((Date.now() - t0) / 1000).toFixed(1)}s, wedged_at=${wedged}s) stats='${done}'`)
  console.log('log tail =', await evalPlus('window.__log.slice(-6)'))
  process.exit(0)
} catch (e) {
  console.error('PROBE3 ERR', e.message)
  process.exit(1)
} finally {
  p.kill()
  preview.kill()
}