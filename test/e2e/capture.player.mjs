import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : null
      srv.close((err) => {
        if (err) reject(err)
        else if (typeof port === 'number') resolve(port)
        else reject(new Error('Failed to allocate a free port'))
      })
    })
  })
}

async function waitForHttpOk(url, timeoutMs = 30_000) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetchWithTimeout(url, { redirect: 'manual' }, 3000)
      try {
        if (res.ok) return
      } finally {
        try {
          res.body?.cancel?.()
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`)
    await sleep(200)
  }
}

function findChromeExe() {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error('Chrome executable not found.')
}

function makeSimpleMidiBytes() {
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x14,
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0x90, 0x3c, 0x40,
    0x83, 0x60, 0x80, 0x3c, 0x00,
    0x00, 0xff, 0x2f, 0x00,
  ]
  return new Uint8Array(bytes)
}

async function createTempMidiFile() {
  const dir = join(tmpdir(), `midi-vis-e2e-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'simple.mid')
  await writeFile(path, makeSimpleMidiBytes())
  return path
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()

    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
        else p.resolve(msg.result)
        return
      }
      if (msg.method) {
        const handlers = this.events.get(msg.method)
        if (!handlers) return
        for (const h of handlers) h(msg.params)
      }
    })

    const rejectAll = (reason) => {
      for (const p of this.pending.values()) {
        try {
          p.reject(reason)
        } catch {
          // ignore
        }
      }
      this.pending.clear()
    }
    this.ws.addEventListener('close', () => rejectAll(new Error('CDP websocket closed')))
    this.ws.addEventListener('error', () => rejectAll(new Error('CDP websocket error')))
  }

  async waitOpen() {
    if (this.ws.readyState === WebSocket.OPEN) return
    await Promise.race([
      new Promise((resolve, reject) => {
        this.ws.addEventListener('open', resolve, { once: true })
        this.ws.addEventListener('error', reject, { once: true })
      }),
      sleep(10_000).then(() => {
        throw new Error('Timed out waiting for CDP websocket to open')
      }),
    ])
  }

  on(method, handler) {
    const list = this.events.get(method) ?? []
    list.push(handler)
    this.events.set(method, list)
  }

  send(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId++
    const payload = { id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}

async function waitForPageWsDebuggerUrl(port, timeoutMs = 30_000) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, {}, 3000)
      if (res.ok) {
        const list = await res.json()
        const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      }
    } catch {
      // ignore
    }
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for a page target in /json/list')
    await sleep(200)
  }
}

async function evalJson(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) throw new Error(`Runtime.evaluate exception: ${res.exceptionDetails.text ?? 'unknown'}`)
  return res.result?.value
}

async function main() {
  const midiPath = await createTempMidiFile()
  const midiDir = dirname(midiPath)
  const outPath = resolve('test', 'e2e', 'artifacts', 'player.png')
  mkdirSync(resolve('test', 'e2e', 'artifacts'), { recursive: true })

  let port = 0
  let baseUrl = ''

  const viteBin = join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) throw new Error(`Vite not found at ${viteBin}`)

  let web = null
  let lastStartErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    port = await getFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    web = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      stdio: 'ignore',
    })
    try {
      await Promise.race([
        waitForHttpOk(baseUrl, 10_000),
        new Promise((_, reject) => {
          web.once('error', reject)
          web.once('exit', (code, signal) => {
            reject(new Error(`Vite exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
          })
        }),
      ])
      lastStartErr = null
      break
    } catch (err) {
      lastStartErr = err
      try {
        web.kill()
      } catch {
        // ignore
      }
      web = null
    }
  }
  if (!web || !baseUrl) throw (lastStartErr instanceof Error ? lastStartErr : new Error(String(lastStartErr ?? 'Failed to start Vite')))

  try {
    const chromeExe = findChromeExe()
    let chromePort = 0
    let chrome = null
    let userDataDir = null
    let lastChromeErr = null
    for (let attempt = 0; attempt < 5; attempt++) {
      chromePort = await getFreePort()
      userDataDir = join(tmpdir(), `midi-vis-chrome-${Date.now()}-${attempt}`)
      mkdirSync(userDataDir, { recursive: true })
      const proc = spawn(
        chromeExe,
        [
          '--headless=new',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${userDataDir}`,
          `--remote-debugging-port=${chromePort}`,
          '--enable-unsafe-webgpu',
          '--enable-features=WebGPU',
          '--window-size=1400,900',
        ],
        { stdio: 'ignore' },
      )

      try {
        await Promise.race([
          waitForHttpOk(`http://127.0.0.1:${chromePort}/json/version`, 10_000),
          new Promise((_, reject) => {
            proc.once('error', reject)
            proc.once('exit', (code, signal) => {
              reject(new Error(`Chrome exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
            })
          }),
        ])
        chrome = proc
        lastChromeErr = null
        break
      } catch (err) {
        lastChromeErr = err
        try {
          proc.kill()
        } catch {
          // ignore
        }
        try {
          rmSync(userDataDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
        userDataDir = null
      }
    }
    if (!chrome || !userDataDir) throw (lastChromeErr instanceof Error ? lastChromeErr : new Error(String(lastChromeErr ?? 'Failed to start Chrome')))

    try {
      const wsUrl = await waitForPageWsDebuggerUrl(chromePort)
      const cdp = new CdpClient(wsUrl)
      await cdp.waitOpen()

      await cdp.send('Page.enable')
      await cdp.send('Runtime.enable')
      await cdp.send('DOM.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1359,
        height: 747,
        deviceScaleFactor: 1,
        mobile: false,
      })

      await cdp.send('Page.navigate', { url: `${baseUrl}/#/` })

      const waitForSelector = async (selector, timeoutMs = 20_000) => {
        const start = Date.now()
        while (true) {
          const exists = await evalJson(cdp, `(() => Boolean(document.querySelector(${JSON.stringify(selector)})))()`)
          if (exists) return
          if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for selector: ${selector}`)
          await sleep(200)
        }
      }
      await waitForSelector('input[type="file"]')

      const doc = await cdp.send('DOM.getDocument', { depth: -1 })
      const rootNodeId = doc.root.nodeId
      const q = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: 'input[type=\"file\"]' })
      if (!q.nodeId) throw new Error('File input not found.')
      await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [midiPath] })
      await evalJson(
        cdp,
        `(() => { const el = document.querySelector('input[type="file"]'); el && el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      )

      const waitHash = async (expected, timeoutMs = 20_000) => {
        const start = Date.now()
        while (true) {
          const h = await evalJson(cdp, 'location.hash')
          if (h === expected) return
          if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for hash ${expected}, got ${h}`)
          await sleep(200)
        }
      }

      await waitHash('#/tracks')

      const startPt = await evalJson(
        cdp,
        `(() => {
          const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Start')
          if (!btn) return null
          btn.scrollIntoView({ block: 'center', inline: 'center' })
          const r = btn.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
        })()`,
      )
      if (!startPt) throw new Error('Start button not found.')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startPt.x, y: startPt.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startPt.x, y: startPt.y, button: 'left', clickCount: 1 })

      const start = Date.now()
      while (true) {
        const h = await evalJson(cdp, 'location.hash')
        if (h === '#/play') break
        const err = await evalJson(cdp, `(() => document.querySelector('.error')?.textContent?.trim() ?? null)()`)
        if (err) throw new Error(`Start failed: ${err}`)
        if (Date.now() - start > 20_000) throw new Error(`Timed out waiting for #/play, got ${h}`)
        await sleep(200)
      }

      await waitForSelector('.player-footer')
      await waitForSelector('.footer-waveform .footer-canvas')

      // Fail fast if WebGPU initialization errored (otherwise this capture is misleading).
      const gpuStart = Date.now()
      while (Date.now() - gpuStart < 5000) {
        const gpuErr = await evalJson(cdp, `(() => document.querySelector('.webgpu-error')?.textContent?.trim() ?? null)()`)
        if (gpuErr) throw new Error(`WebGPU error: ${gpuErr}`)
        await sleep(200)
      }

      const frameBox = await evalJson(
        cdp,
        `(() => {
          const r = document.querySelector('.app-frame')?.getBoundingClientRect()
          return r ? { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio } : null
        })()`,
      )
      if (!frameBox) throw new Error('app-frame not found.')

      const png = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: frameBox.x, y: frameBox.y, width: frameBox.w, height: frameBox.h, scale: 1 },
      })
      await writeFile(outPath, Buffer.from(png.data, 'base64'))
      cdp.close()
      console.log(`Wrote ${outPath}`)
    } finally {
      try {
        chrome.kill()
      } catch {
        // ignore
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      web.kill()
    } catch {
      // ignore
    }
    try {
      rmSync(midiDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

