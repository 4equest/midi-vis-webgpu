import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function log(msg) {
  if (process.env.E2E_DEBUG) console.log(msg)
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
  // Minimal SMF format 0, 1 track, 480 ppq, tempo 120, a single C4 quarter note.
  const bytes = [
    // MThd header
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    // MTrk chunk header (length 0x14)
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x14,
    // delta=0 tempo
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    // delta=0 note on (C4)
    0x00, 0x90, 0x3c, 0x40,
    // delta=480 note off
    0x83, 0x60, 0x80, 0x3c, 0x00,
    // delta=0 end of track
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
  log('e2e: start')
  const midiPath = await createTempMidiFile()
  const midiDir = dirname(midiPath)
  let userDataDir = null

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
      log('e2e: waiting for dev server')
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
    let lastChromeErr = null
    for (let attempt = 0; attempt < 5; attempt++) {
      chromePort = await getFreePort()
      const dir = join(tmpdir(), `midi-vis-chrome-${Date.now()}-${attempt}`)
      mkdirSync(dir, { recursive: true })
      const proc = spawn(
        chromeExe,
        [
          '--headless=new',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${dir}`,
          `--remote-debugging-port=${chromePort}`,
          '--enable-unsafe-webgpu',
          '--enable-features=WebGPU',
          '--window-size=900,520',
        ],
        { stdio: 'ignore' },
      )

      try {
        log('e2e: waiting for chrome debug port')
        await Promise.race([
          waitForHttpOk(`http://127.0.0.1:${chromePort}/json/version`, 10_000),
          new Promise((_, reject) => {
            proc.once('error', reject)
            proc.once('exit', (code, signal) => {
              reject(new Error(`Chrome exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
            })
          }),
        ])

        userDataDir = dir
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
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
    if (!chrome) {
      throw lastChromeErr instanceof Error ? lastChromeErr : new Error(String(lastChromeErr ?? 'Failed to start Chrome'))
    }

    try {
      const wsUrl = await waitForPageWsDebuggerUrl(chromePort)
      let cdp = null
      try {
        cdp = new CdpClient(wsUrl)
        await cdp.waitOpen()

        log('e2e: enabling CDP domains')
        await cdp.send('Page.enable')
        await cdp.send('Runtime.enable')
        await cdp.send('DOM.enable')

        log('e2e: navigating')
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

        // Upload MIDI.
        log('e2e: uploading midi')
        const doc = await cdp.send('DOM.getDocument', { depth: -1 })
        const rootNodeId = doc.root.nodeId
        const q = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: 'input[type=\"file\"]' })
        if (!q.nodeId) throw new Error('File input not found on upload page.')
        await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [midiPath] })
        // Some chromium builds don't emit change for setFileInputFiles; ensure it.
        await evalJson(
          cdp,
          `(() => { const el = document.querySelector('input[type=\"file\"]'); el && el.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        )

        // Wait for TrackSelectPage.
        const waitHash = async (expected, timeoutMs = 20_000) => {
          const start = Date.now()
          while (true) {
            const h = await evalJson(cdp, 'location.hash')
            if (h === expected) return
            if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for hash ${expected}, got ${h}`)
            await sleep(200)
          }
        }

        log('e2e: waiting for tracks page')
        await waitHash('#/tracks')

        // Click Start.
        log('e2e: clicking start')
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
        if (!startPt) throw new Error('Start button not found on TrackSelectPage.')
        if (!Number.isFinite(startPt.x) || !Number.isFinite(startPt.y) || startPt.w < 5 || startPt.h < 5) {
          throw new Error(`Start button has invalid box: ${JSON.stringify(startPt)}`)
        }
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: startPt.x,
          y: startPt.y,
          button: 'left',
          clickCount: 1,
        })
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: startPt.x,
          y: startPt.y,
          button: 'left',
          clickCount: 1,
        })

        // Wait for PlayerPage or surface a TrackSelect error message.
        log('e2e: waiting for player page')
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

        // Poll for a short window to catch late WebGPU failures.
        const gpuStart = Date.now()
        while (Date.now() - gpuStart < 5000) {
          const gpuErr = await evalJson(cdp, `(() => document.querySelector('.webgpu-error')?.textContent?.trim() ?? null)()`)
          if (gpuErr) throw new Error(`WebGPU error: ${gpuErr}`)
          await sleep(200)
        }

        const boxes = await evalJson(
          cdp,
          `(() => {
            const toBox = (r) =>
              r
                ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
                : null
            const frame = toBox(document.querySelector('.app-frame')?.getBoundingClientRect())
           const player = toBox(document.querySelector('.player')?.getBoundingClientRect())
           const footer = toBox(document.querySelector('.player-footer')?.getBoundingClientRect())
           const seek = toBox(document.querySelector('.footer-progress')?.getBoundingClientRect())
           const spec = toBox(document.querySelector('.footer-left .footer-canvas')?.getBoundingClientRect())
           const beatProg = toBox(document.querySelector('.footer-right-beat-progress')?.getBoundingClientRect())
           const subBeatProg = toBox(document.querySelector('.footer-right-subbeat-progress')?.getBoundingClientRect())
           const wave = toBox(document.querySelector('.footer-waveform .footer-canvas')?.getBoundingClientRect())
           return {
             frame,
             player,
             footer,
             seek,
             spec,
             beatProg,
             subBeatProg,
             wave,
             hash: location.hash,
             viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
             scroll: { x: window.scrollX, y: window.scrollY },
           }
         })()`,
        )

        const mustHaveBox = (name) => {
          const b = boxes?.[name]
          if (!b) throw new Error(`${name} box missing`)
          if (b.width < 5 || b.height < 5) throw new Error(`${name} too small: ${JSON.stringify(b)}`)
          return b
        }
       const frame = mustHaveBox('frame')
       const seek = mustHaveBox('seek')
       const spec = mustHaveBox('spec')
       const beatProg = mustHaveBox('beatProg')
       const subBeatProg = mustHaveBox('subBeatProg')
       const wave = mustHaveBox('wave')

        const within = (b) =>
          b.left >= frame.left - 1 &&
          b.top >= frame.top - 1 &&
          b.right <= frame.right + 1 &&
          b.bottom <= frame.bottom + 1
       if (!within(seek)) throw new Error(`seek box out of frame: ${JSON.stringify(boxes)}`)
       if (!within(spec)) throw new Error(`spec box out of frame: ${JSON.stringify(boxes)}`)
       if (!within(beatProg)) throw new Error(`beat prog box out of frame: ${JSON.stringify(boxes)}`)
       if (!within(subBeatProg)) throw new Error(`sub-beat prog box out of frame: ${JSON.stringify(boxes)}`)
       if (!within(wave)) throw new Error(`waveform box out of frame: ${JSON.stringify(boxes)}`)
       if (wave.top < subBeatProg.bottom - 1) throw new Error(`waveform not below beat display: ${JSON.stringify(boxes)}`)

       if (Math.abs(seek.top - wave.top) > 1.5) {
         throw new Error(`waveform not aligned with seek bar: ${JSON.stringify(boxes)}`)
       }

        log('e2e: ok')
      } finally {
        cdp?.close()
      }
    } finally {
      try {
        chrome.kill()
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
      if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
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

