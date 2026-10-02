/**
 * Host half of dsh-shot-ask.
 *
 * The capture UI itself is browser-only and lives in `lib/client.js`; this entry
 * is also what makes the `dsh.client` declaration in package.json visible to the
 * client-modules scanner, which is how the browser bundle reaches
 * `window.__DSH_BOOT__`.
 *
 * On top of that mounting role it serves two read-only routes, because two things
 * the settings row shows cannot be read from a page: the on-disk capture
 * directory and whether the DSH bridge is answering. Both stay loopback-only,
 * like every route on this web surface.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-shot-ask'

/** The web server hosts the two read-only routes. */
export const inject = ['webServer']

const INFO_PATH = '/dsh-shot-ask/info'
const BRIDGE_TEST_PATH = '/dsh-shot-ask/bridge-test'
const CAPTURE_PATH = '/dsh-shot-ask/capture.png'

/**
 * Windows screen capture for the page.
 *
 * The Desktop shell answers `getDisplayMedia` with an empty grant and denies
 * every permission request, so a Desktop window cannot acquire a display stream
 * at all. This script captures the display under the cursor instead: the pointer
 * has just clicked the ball, so it sits on the screen the user means. The PNG
 * travels back as base64 on stdout, which keeps binary bytes out of the console
 * encoding.
 */
const CAPTURE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  '$cursor = [System.Windows.Forms.Cursor]::Position',
  '$screen = [System.Windows.Forms.Screen]::FromPoint($cursor)',
  '$bounds = $screen.Bounds',
  '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
  '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
  '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
  '$stream = New-Object System.IO.MemoryStream',
  '$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
  '[Convert]::ToBase64String($stream.ToArray())',
].join('\n')

/**
 * Capture the display under the cursor.
 * @returns {Promise<Buffer>} the encoded PNG bytes.
 */
function captureScreen() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('native capture is available on Windows only'))
      return
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true })
    const chunks = []
    let diagnostics = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { diagnostics += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      const encoded = Buffer.concat(chunks).toString('utf8').trim()
      if (code !== 0 || encoded === '') {
        reject(new Error(`capture failed (exit ${String(code)}): ${diagnostics.trim().slice(0, 300)}`))
        return
      }
      resolve(Buffer.from(encoded, 'base64'))
    })
    child.stdin.end(CAPTURE_SCRIPT)
  })
}

/**
 * Where the desktop capture ball writes PNGs.
 *
 * This mirrors `dsh-shot-ball/main.js`: it honours `DSH_SHOT_BALL_CAPTURES` and
 * otherwise uses the user's Pictures folder. The two must stay in step.
 * @returns the absolute capture directory.
 */
function captureDir() {
  const override = process.env.DSH_SHOT_BALL_CAPTURES
  if (typeof override === 'string' && override !== '') return override
  return path.join(os.homedir(), 'Pictures', 'dsh-shot-ball')
}

/** The coordinates file the bridge plugin writes on activation. */
function bridgeFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-shot-bridge.json')
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Ask the bridge whether it is alive, and how many sessions it can see.
 * @returns {Promise<{ok: boolean, sessions?: number, message?: string}>}
 */
async function probeBridge() {
  let config = null
  try {
    config = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8'))
  } catch {
    return { ok: false, message: '没找到 dsh-shot-bridge.json，桥接插件可能没生效' }
  }
  if (typeof config.healthUrl !== 'string') {
    return { ok: false, message: '桥接配置里没有 healthUrl' }
  }
  try {
    const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { ok: false, message: `health 返回 HTTP ${response.status}` }
    const body = await response.json()
    const sessions = Array.isArray(body.sessions) ? body.sessions.length : undefined
    return {
      ok: body.ok === true,
      ...(sessions === undefined ? {} : { sessions }),
      ...(body.ok === true ? {} : { message: '桥接报告未就绪' }),
    }
  } catch (error) {
    return { ok: false, message: `连不上桥接：${error.message}` }
  }
}

export function apply(ctx) {
  const disposeInfo = ctx.webServer.register({
    kind: 'exact',
    path: INFO_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { error: 'use GET' }); return }
      const dir = captureDir()
      let captureCount = 0
      try { captureCount = fs.readdirSync(dir).filter((name) => name.endsWith('.png')).length } catch { /* an absent directory simply means zero */ }
      json(res, 200, {
        ok: true,
        captureDir: dir,
        captureCount,
        bridgeConfigured: fs.existsSync(bridgeFile()),
      })
    },
  })

  const disposeBridge = ctx.webServer.register({
    kind: 'exact',
    path: BRIDGE_TEST_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { error: 'use GET' }); return }
      void probeBridge().then((result) => json(res, 200, result))
    },
  })

  const disposeCapture = ctx.webServer.register({
    kind: 'exact',
    path: CAPTURE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { error: 'use GET' }); return }
      captureScreen().then((png) => {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(png.byteLength),
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        res.end(png)
      }, (error) => { json(res, 501, { ok: false, message: error.message }) })
    },
  })

  ctx.effect(() => () => {
    disposeInfo()
    disposeBridge()
    disposeCapture()
  }, 'dsh-shot-ask: settings routes')

  ctx.logger?.info?.('[dsh-shot-ask] routes mounted at %s, %s and %s', INFO_PATH, BRIDGE_TEST_PATH, CAPTURE_PATH)
}
