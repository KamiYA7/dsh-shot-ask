/**
 * dsh-shot-ball — the desktop capture ball.
 *
 * One always-on-top frameless window (the ball) plus, per capture, one overlay
 * window per display carrying a frozen screenshot to box-select on. The frozen
 * region is saved to disk, the human types a question, and the pair is handed
 * to a small loopback bridge served by a DSH plugin, which admits it as a real
 * prompt into the session.
 *
 * Why PowerShell for pixels: `CopyFromScreen` on this machine returns real
 * desktop content for the full virtual desktop (3000x1920 at -1080,-418, 96 DPI,
 * no scaling). Electron's `desktopCapturer` is the fallback when that fails.
 *
 * Coordinates: every rectangle here is virtual-desktop space — the same space
 * `screen.getAllDisplays()` reports and the same one `capture.ps1` captures, so
 * a selection rectangle needs no conversion on the way in or out.
 */
const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ── keep every cache off the system drive ────────────────────────────────────
//
// Electron defaults `userData` (and therefore the HTTP cache, Code Cache, GPU
// cache, Local Storage, and the crash dumps) to `%APPDATA%\<app>` on C:. This
// project lives on G: and C: is nearly full, so both roots are redirected here.
// `setPath` must run before `app.whenReady()`: Chromium resolves these paths as
// it initializes, and a later call would be ignored.
//
// Both are overridable so a different machine does not need a code edit:
//   DSH_SHOT_BALL_HOME   — userData / browser state root
//   DSH_SHOT_BALL_CACHE  — Chromium HTTP + temp cache root
const DSH_ROOT = process.env.DSH_HOME ? path.dirname(process.env.DSH_HOME) : 'G:\\ZM\\DSH'
const BALL_STATE_ROOT = process.env.DSH_SHOT_BALL_HOME
  || path.join(DSH_ROOT, 'zmdsh', 'dsh-shot-ball', '.userdata')
const BALL_CACHE_ROOT = process.env.DSH_SHOT_BALL_CACHE
  || path.join(DSH_ROOT, 'zmdsh', 'dsh-shot-ball', '.cache')

// The launcher passes `--user-data-dir` to a second instance; honour it by
// leaving the path alone when Electron already resolved one from the CLI.
if (!process.argv.some((arg) => arg.startsWith('--user-data-dir'))) {
  app.setPath('userData', BALL_STATE_ROOT)
}
app.setPath('sessionData', path.join(BALL_CACHE_ROOT, 'session'))
app.setPath('temp', path.join(BALL_CACHE_ROOT, 'temp'))

const BALL_SIZE = 58
// The ball window is wider than the ball so the toast has somewhere to live.
// Transparent pixels outside the ball do not take clicks.
const BALL_WINDOW = { width: 420, height: 132 }
/** Longest edge kept in a capture; larger selections are downscaled once. */
const MAX_CAPTURE_EDGE = 2560
/** Let the compositor remove the overlays before the shutter opens. */
const OVERLAY_HIDE_SETTLE_MS = 70
// Captures stay under the user's Pictures folder; override with DSH_SHOT_BALL_CAPTURES.
const CAPTURE_DIR = process.env.DSH_SHOT_BALL_CAPTURES
  || path.join(os.homedir(), 'Pictures', 'dsh-shot-ball')
const BRIDGE_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'dsh-shot-bridge.json',
)

/** @type {BrowserWindow | null} */
let ballWindow = null
/** @type {BrowserWindow[]} */
let overlayWindows = []
/** Frozen desktops for the in-flight capture: displayId -> {png, bounds}. */
let frozen = new Map()
let captureInFlight = false

// ── preferences (window position, hidden flag) ───────────────────────────────

const prefsFile = () => path.join(app.getPath('userData'), 'preferences.json')

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch }
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true })
    fs.writeFileSync(prefsFile(), JSON.stringify(next, null, 2))
  } catch {
    // A read-only profile must not stop the ball from working this session.
  }
  return next
}

// ── the ball ─────────────────────────────────────────────────────────────────

function createBall() {
  const prefs = readPrefs()
  // `prefs.hidden` records a previous × press, but it must not suppress the
  // window forever: the × hides the ball for that session and the next launch
  // shows it again, which is what its tooltip promises. The process keeps
  // running while hidden, so the global hotkey stays alive either way.

  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const defaultX = area.x + area.width - BALL_WINDOW.width + 200
  const defaultY = area.y + area.height - BALL_WINDOW.height - 40

  ballWindow = new BrowserWindow({
    width: BALL_WINDOW.width,
    height: BALL_WINDOW.height,
    x: typeof prefs.x === 'number' ? prefs.x : defaultX,
    y: typeof prefs.y === 'number' ? prefs.y : defaultY,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 'screen-saver' keeps the ball above ordinary full-screen windows too.
  ballWindow.setAlwaysOnTop(true, 'screen-saver')
  ballWindow.loadFile(path.join(__dirname, 'renderer', 'ball.html'))

  // Remember where the human parked it. `moved` fires after a drag settles.
  ballWindow.on('moved', () => {
    if (ballWindow === null || ballWindow.isDestroyed()) return
    const [x, y] = ballWindow.getPosition()
    writePrefs({ x, y })
  })

  ballWindow.on('closed', () => { ballWindow = null })
}

function showBall() {
  writePrefs({ hidden: false })
  if (ballWindow === null || ballWindow.isDestroyed()) createBall()
  else ballWindow.show()
}

/**
 * Put the ball back after a capture, but only if the user has not hidden it.
 *
 * `hideBall()` is a user instruction for the rest of the session; an
 * unconditional `show()` here made the ball reappear right after every capture,
 * so a hidden ball never stayed hidden.
 */
function restoreBall() {
  if (readPrefs().hidden === true) return
  const ball = ballWindow
  if (ball !== null && !ball.isDestroyed()) ball.show()
}

function hideBall() {
  writePrefs({ hidden: true })
  if (ballWindow !== null && !ballWindow.isDestroyed()) ballWindow.hide()
}

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * Shutter paths, fastest first. Measured steady-state on this machine for an
 * 800x600 region:
 *
 *   native helper (dsh-shot-capture.exe)  323–471 ms
 *   powershell.exe + capture.ps1         2575–3995 ms
 *   Electron desktopCapturer             ~2400 ms for both screens, and it caps
 *                                        a 1080x1920 screen at 608x1080
 *
 * `powershell.exe` startup alone is 1130 ms, which is why the ordering is not
 * about the capture work at all. The native helper is compiled once from
 * `scripts/Capture.cs` by the .NET Framework compiler that ships with Windows,
 * so no toolchain has to be installed.
 */
const CAPTURE_EXE = path.join(__dirname, 'scripts', 'dsh-shot-capture.exe')
const CAPTURE_CS = path.join(__dirname, 'scripts', 'Capture.cs')

/** Run one child process to completion, capturing its output. */
function runProcess(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** Locate the .NET Framework C# compiler that ships with Windows. */
function csharpCompiler() {
  const candidates = [
    process.env.DSH_SHOT_CSC,
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Compile the native shutter once, if it is missing or older than its source.
 * Failure is not fatal: the PowerShell script remains as the fallback path.
 * @returns {Promise<boolean>} whether a usable helper exists afterwards.
 */
async function ensureCaptureHelper() {
  const compiled = fs.existsSync(CAPTURE_EXE)
  const stale = compiled && fs.existsSync(CAPTURE_CS)
    && fs.statSync(CAPTURE_CS).mtimeMs > fs.statSync(CAPTURE_EXE).mtimeMs
  if (compiled && !stale) return true
  if (!fs.existsSync(CAPTURE_CS)) return compiled
  const csc = csharpCompiler()
  if (csc === null) {
    ballLog('csc.exe not found; the native shutter stays unavailable and PowerShell will be used')
    return false
  }
  const started = Date.now()
  try {
    const result = await runProcess(csc, [
      '/nologo', '/optimize+', '/target:exe',
      `/out:${CAPTURE_EXE}`, '/reference:System.Drawing.dll', CAPTURE_CS,
    ])
    if (result.code !== 0 || !fs.existsSync(CAPTURE_EXE)) {
      ballLog(`native shutter compile failed (${result.code}): ${(result.err || result.out).trim().slice(0, 300)}`)
      return false
    }
    ballLog(`native shutter compiled in ${Date.now() - started} ms -> ${CAPTURE_EXE}`)
    return true
  } catch (error) {
    ballLog(`native shutter compile threw: ${error.message}`)
    return false
  }
}

/** Run the compiled native shutter for one virtual-desktop rectangle. */
async function captureRegionWithHelper(x, y, width, height, outFile) {
  const result = await runProcess(CAPTURE_EXE, [
    String(Math.round(x)), String(Math.round(y)),
    String(Math.round(width)), String(Math.round(height)), outFile,
  ])
  if (result.code !== 0 || !fs.existsSync(outFile)) {
    throw new Error(`capture helper exited ${result.code}: ${(result.err || result.out).trim().slice(0, 300)}`)
  }
  return outFile
}

/** Run `capture.ps1` for one virtual-desktop rectangle (fallback shutter). */
async function captureRegionWithPowerShell(x, y, width, height, outFile) {
  const script = path.join(__dirname, 'scripts', 'capture.ps1')
  const exe = process.env.DSH_SHOT_PS || 'powershell.exe'
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-X', String(Math.round(x)), '-Y', String(Math.round(y)),
    '-Width', String(Math.round(width)), '-Height', String(Math.round(height)),
    '-Out', outFile,
  ]
  const result = await runProcess(exe, args)
  if (result.code !== 0 || !fs.existsSync(outFile)) {
    throw new Error(`capture.ps1 exited ${result.code}: ${(result.err || result.out).trim().slice(0, 400)}`)
  }
  return outFile
}

/**
 * Fallback path: capture one region through Electron instead of PowerShell.
 *
 * `desktopCapturer` returns a thumbnail per screen; the requested rectangle is
 * cropped out of the matching display's thumbnail in proportion to its real size.
 * Measured slower than PowerShell on this machine (2.4 s for both screens, and it
 * caps a 1080x1920 portrait screen at 608x1080), so it is the fallback, not the
 * primary path.
 *
 * @param {number} displayId - Electron display id.
 * @param {{x:number,y:number,width:number,height:number}} bounds - that display's bounds.
 * @param {{x:number,y:number,width:number,height:number}} rect - virtual-desktop region.
 * @returns {Promise<Buffer>} PNG bytes of the region.
 */
async function captureRegionWithElectron(displayId, bounds, rect) {
  const { nativeImage } = require('electron')
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: bounds.width, height: bounds.height },
  })
  const match = sources.find((source) => String(source.display_id) === String(displayId)) || sources[0]
  if (match === undefined) throw new Error('desktopCapturer returned no screen source')
  const image = match.thumbnail
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) throw new Error('desktopCapturer returned an empty thumbnail')
  const scaleX = size.width / bounds.width
  const scaleY = size.height / bounds.height
  const localX = rect.x - bounds.x
  const localY = rect.y - bounds.y
  const crop = {
    x: Math.max(0, Math.min(size.width - 1, Math.round(localX * scaleX))),
    y: Math.max(0, Math.min(size.height - 1, Math.round(localY * scaleY))),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  }
  crop.width = Math.min(crop.width, size.width - crop.x)
  crop.height = Math.min(crop.height, size.height - crop.y)
  const cropped = image.crop(crop)
  if (cropped.isEmpty()) throw new Error('electron region capture produced an empty image')
  return cropped.toPNG()
}

/** List every display as a selection frame. No pixels are touched here. */
async function listDisplayFrames() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true })
  const displays = screen.getAllDisplays()
  frozen = new Map()
  /** @type {Array<{id:number, bounds:object}>} */
  const frames = []

  for (const display of displays) {
    const { x, y, width, height } = display.bounds
    frozen.set(display.id, { png: null, bounds: { x, y, width, height }, file: null })
    frames.push({ id: display.id, bounds: { x, y, width, height } })
  }
  return frames
}

/**
 * Tear down every overlay window and the frames behind them.
 *
 * No image files are left to clean up any more: the overlays carry no pixels,
 * because the screenshot is taken from the live desktop after the selection is
 * known (see the timings in `captureSelection`).
 */
function closeOverlays() {
  for (const window of overlayWindows) {
    if (!window.isDestroyed()) window.destroy()
  }
  overlayWindows = []
  frozen = new Map()
  captureInFlight = false
}

/**
 * Capture exactly one selected region from the live desktop.
 *
 * The old design froze every display the moment the ball was clicked, painted
 * those frames into the overlays, and cropped the answer out of them. Measured on
 * this machine, that cost 3.5–4.7 s per click — PowerShell is only ~1 s per
 * display, and the rest was PNG-encoding two screens (a 1080x1920 portrait screen
 * encodes to 2.2 MB) and shipping them to the renderer as base64 over IPC.
 *
 * Capturing the selection instead means the click path does no image work at all:
 * the overlays are transparent and appear in milliseconds, and only the chosen
 * rectangle is ever encoded. The overlays are hidden before the shutter opens so
 * the veil and the marquee cannot land in the picture.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect - virtual-desktop rectangle.
 * @returns {Promise<{file:string, ms:number}>} saved path plus the capture duration.
 */
async function captureSelection(rect) {
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  const started = Date.now()

  // Let the compositor actually remove the overlays before reading the screen;
  // without this the mauve veil and the marquee bleed into the capture.
  hideOverlaysImmediately()
  await new Promise((resolve) => setTimeout(resolve, OVERLAY_HIDE_SETTLE_MS))

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(CAPTURE_DIR, `shot-${stamp}.png`)
  try {
    await captureRegionWithHelper(x, y, width, height, file)
  } catch (helperError) {
    // The fast shutter failed (or was never compiled): fall back to the script,
    // then to Electron, before giving up on a selection the human already made.
    ballLog(`native shutter failed: ${helperError.message}; trying powershell`)
    try {
      await captureRegionWithPowerShell(x, y, width, height, file)
    } catch (psError) {
      ballLog(`powershell shutter failed: ${psError.message}; trying desktopCapturer`)
      const display = screen.getDisplayNearestPoint({ x, y })
      const png = await captureRegionWithElectron(display.id, display.bounds, { x, y, width, height })
      fs.writeFileSync(file, png)
    }
  }
  let bytes = fs.readFileSync(file)

  // Cap the long edge: a full-height portrait selection can still be large, and
  // the encode time the renderer spends on a preview should stay bounded.
  if (Math.max(width, height) > MAX_CAPTURE_EDGE) {
    try {
      const { nativeImage } = require('electron')
      const image = nativeImage.createFromBuffer(bytes).resize({
        width: width >= height ? MAX_CAPTURE_EDGE : undefined,
        height: height > width ? MAX_CAPTURE_EDGE : undefined,
        quality: 'good',
      })
      if (!image.isEmpty()) {
        bytes = image.toPNG()
        fs.writeFileSync(file, bytes)
      }
    } catch (error) {
      ballLog(`downscale skipped: ${error.message}`)
    }
  }

  return { file, ms: Date.now() - started, bytes: bytes.length, width, height }
}

/** Hide the overlays without tearing down the capture state. */
function hideOverlaysImmediately() {
  for (const window of overlayWindows) {
    if (!window.isDestroyed()) window.hide()
  }
}

/** Open one borderless transparent selection overlay per display. */
function openOverlays(frames) {
  for (const frame of frames) {
    const overlay = new BrowserWindow({
      x: frame.bounds.x,
      y: frame.bounds.y,
      width: frame.bounds.width,
      height: frame.bounds.height,
      frame: false,
      // Transparent: the live desktop shows through, so no frozen screenshot has
      // to be produced, transferred, or decoded before the human can select.
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'))
    overlay.webContents.once('did-finish-load', () => {
      overlay.webContents.send('overlay:init', { id: frame.id, bounds: frame.bounds })
    })
    // A closed overlay (Esc path) ends the whole capture.
    overlay.on('closed', () => {
      if (captureInFlight && overlayWindows.every((entry) => entry.isDestroyed())) {
        closeOverlays()
        askBallToRender('capture-cancelled')
      }
    })
    overlayWindows.push(overlay)
  }
}

// ── the question window ──────────────────────────────────────────────────────

/**
 * Every open question window, keyed by its `webContents.id`.
 *
 * One capture can leave its question window unanswered while the next capture
 * opens another, so a single slot would drop the first window on the floor: its
 * submit or cancel would then act on whichever window happened to be newest.
 * The key is the identity the IPC layer reports for the sender, so
 * window -> entry and entry -> window are the same lookup.
 * @type {Map<number, {id: number, window: BrowserWindow}>}
 */
const askWindows = new Map()

/**
 * Resolve the question window that sent one IPC message.
 *
 * The sender — never "the newest window" — decides which entry an action
 * applies to, so concurrent question windows cannot act on each other.
 * @param {Electron.IpcMainInvokeEvent} event - the invoke event carrying `sender`.
 * @returns {{id: number, window: BrowserWindow} | undefined} that window's entry.
 */
function askEntryForEvent(event) {
  const sender = BrowserWindow.fromWebContents(event.sender)
  if (sender === null) return undefined
  return askWindows.get(sender.webContents.id)
}

/** Open one question window for a saved capture and start tracking it. */
function openAskWindow(cropPath, rect) {
  const display = screen.getDisplayNearestPoint({ x: rect.x, y: rect.y })
  const area = display.workArea
  const width = 560
  const height = 232
  const x = Math.round(Math.min(Math.max(area.x + 24, rect.x), area.x + area.width - width - 24))
  const y = Math.round(Math.min(Math.max(area.y + 24, rect.y + rect.height + 12), area.y + area.height - height - 24))

  const askWindow = new BrowserWindow({
    width,
    height,
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  const id = askWindow.webContents.id
  askWindows.set(id, { id, window: askWindow })
  askWindow.setAlwaysOnTop(true, 'screen-saver')
  askWindow.loadFile(path.join(__dirname, 'renderer', 'ask.html'))
  askWindow.webContents.once('did-finish-load', () => {
    if (askWindow.isDestroyed()) return
    askWindow.webContents.send('ask:init', {
      imagePath: cropPath,
      imageUrl: `file://${cropPath.replace(/\\/g, '/')}`,
      bridge: readBridgeConfig(),
    })
  })
  // A window leaves the map however it closes — submit, cancel, the renderer's
  // own `window.close()`, or the human — and only ever removes its own entry.
  askWindow.on('closed', () => { askWindows.delete(id) })
  ballLog(`ask window opened (id ${id}); ${askWindows.size} open`)
}

/**
 * Close one tracked question window and drop its entry.
 *
 * The entry is deleted before the destroy so a repeat call for the same window
 * is a no-op even if the `closed` event has not run yet.
 * @param {{id: number, window: BrowserWindow} | undefined} entry - window to close.
 */
function closeAskWindow(entry) {
  if (entry === undefined) return
  askWindows.delete(entry.id)
  if (!entry.window.isDestroyed()) entry.window.destroy()
  ballLog(`ask window closed (id ${entry.id}); ${askWindows.size} open`)
}

// ── logging ──────────────────────────────────────────────────────────────────

// A file sink exists because a click that does nothing is otherwise
// indistinguishable from a click that never arrived. Both halves of the app
// append here, so one file shows whether an event fired at all. It lives under
// the G: cache root rather than %TEMP% so nothing this app writes lands on C:.
const LOG_FILE = path.join(BALL_CACHE_ROOT, 'dsh-shot-ball.log')

function ballLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  process.stdout.write(`[dsh-shot-ball] ${message}\n`)
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* logging must never throw */ }
}

// ── the DSH bridge ───────────────────────────────────────────────────────────

/**
 * Read the loopback bridge coordinates a DSH plugin writes on activation.
 * @returns {{port:number, token:string} | null}
 */
function readBridgeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'))
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/**
 * Hand the capture and the question to DSH and wait for admission.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function submitToBridge(imagePath, question) {
  const bridge = readBridgeConfig()
  if (bridge === null) {
    return {
      ok: false,
      message: `没找到 DSH 桥接配置。确认 DSH 里装了 dsh-shot-ask 并重启过（期望文件：${BRIDGE_FILE}）。图片已存到本地。`,
    }
  }
  let bytes
  try {
    bytes = fs.readFileSync(imagePath)
  } catch (error) {
    return { ok: false, message: `读取图片失败：${error.message}` }
  }
  const payload = JSON.stringify({
    question,
    image: { mediaType: 'image/png', data: bytes.toString('base64'), name: path.basename(imagePath) },
    savedTo: imagePath,
  })
  // Use the URL the bridge published, not a path assembled from its port. The
  // route lives under a plugin-owned prefix (`/dsh-shot-bridge/submit`); posting
  // to a hardcoded `/submit` reached the web surface's fallback handler instead,
  // which answers 405 with an empty body — the symptom that looked like a
  // rejection from the bridge.
  const endpoint = typeof bridge.url === 'string' && bridge.url !== ''
    ? bridge.url
    : `http://127.0.0.1:${bridge.port}/dsh-shot-bridge/submit`
  const url = `${endpoint}?token=${encodeURIComponent(bridge.token)}`
  ballLog(`submit -> POST ${endpoint} (${bytes.length} bytes, ${question.length} chars). savedTo=${imagePath}`)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* non-JSON error body is reported raw */ }
    ballLog(`submit <- HTTP ${response.status} ${response.statusText || ''} body=${text.slice(0, 400)}`)
    if (!response.ok) {
      // An empty body with a 404/405 means the request never reached the plugin
      // route at all, which is a different problem from a refusal with a reason.
      const detail = (parsed && parsed.error) || text.slice(0, 300)
      const hint = detail === ''
        ? `（响应为空；确认桥接路由是 ${endpoint}）`
        : detail
      return { ok: false, message: `DSH 拒绝了提交（HTTP ${response.status}）：${hint}` }
    }
    return { ok: true, message: (parsed && parsed.message) || '已提交给 DSH' }
  } catch (error) {
    ballLog(`submit !! ${error.message}`)
    return { ok: false, message: `连不上 DSH 桥接（${endpoint}）：${error.message}` }
  }
}

// ── logging ──────────────────────────────────────────────────────────────────

function askBallToRender(kind) {
  if (ballWindow !== null && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('ball:state', { kind })
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** Renderer → main log line (the renderer cannot write files itself). */
ipcMain.handle('ball:log', (_event, message) => {
  ballLog(`renderer: ${String(message)}`)
  return { ok: true }
})

/**
 * Nudge the ball window by a pointer delta. Deltas are clamped because a
 * stale or platform-odd `screenX/screenY` reading must not fling the window
 * across the desktop; the position is clamped hard to the display work areas.
 */
ipcMain.handle('ball:move-by', (_event, delta) => {
  if (ballWindow === null || ballWindow.isDestroyed()) return { ok: false }
  const dx = Math.max(-400, Math.min(400, Math.round(Number(delta && delta.dx) || 0)))
  const dy = Math.max(-400, Math.min(400, Math.round(Number(delta && delta.dy) || 0)))
  if (dx === 0 && dy === 0) return { ok: true }
  const [x, y] = ballWindow.getPosition()
  const display = screen.getDisplayNearestPoint({ x: x + BALL_SIZE, y: y + BALL_SIZE })
  const area = display.workArea
  const nextX = Math.max(area.x - (BALL_WINDOW.width - BALL_SIZE), Math.min(area.x + area.width - BALL_SIZE, x + dx))
  const nextY = Math.max(area.y, Math.min(area.y + area.height - BALL_SIZE, y + dy))
  ballWindow.setPosition(Math.round(nextX), Math.round(nextY))
  // Persist every step so the position survives even a hard kill.
  writePrefs({ x: Math.round(nextX), y: Math.round(nextY) })
  return { ok: true }
})

/** Default capture accelerator; `captureHotkey` in preferences.json replaces it. */
const DEFAULT_CAPTURE_HOTKEY = 'Control+Alt+S'

/**
 * Start one capture: freeze every display, hide the ball, and open the region
 * overlays. The ball's click and the global hotkey both enter here, so the two
 * entry points cannot drift apart.
 * @returns {Promise<{ok: boolean, message?: string}>} the request outcome.
 */
async function beginCapture() {
  // Self-heal: a capture that never tore its overlays down must not refuse every
  // later hotkey for the rest of the session. No live overlay means no capture
  // is actually in flight, whatever the flag says.
  if (captureInFlight && overlayWindows.every((entry) => entry.isDestroyed())) {
    ballLog('stale capture state cleared: the flag was set but no overlay is alive')
    closeOverlays()
  }
  if (captureInFlight) {
    ballLog('capture refused: a capture is already in progress')
    return { ok: false, message: '已有一次截图在进行中' }
  }
  captureInFlight = true
  try {
    const started = Date.now()
    const frames = await listDisplayFrames()
    // Hide the ball so it never lands in its own screenshot.
    if (ballWindow !== null && !ballWindow.isDestroyed()) ballWindow.hide()
    openOverlays(frames)
    ballLog(`overlays opened for ${frames.length} display(s) in ${Date.now() - started} ms`)
    return { ok: true }
  } catch (error) {
    ballLog(`capture failed: ${error.message}`)
    captureInFlight = false
    return { ok: false, message: `抓屏失败：${error.message}` }
  }
}

/**
 * Register the system-wide capture hotkey.
 *
 * A combination another application already owns stays unregistered and is
 * reported in the ball's log: silently losing the entry point while the ball
 * still floats on screen would be worse than a loud line.
 */
function registerCaptureHotkey() {
  const prefs = readPrefs()
  const accelerator = typeof prefs.captureHotkey === 'string' && prefs.captureHotkey !== ''
    ? prefs.captureHotkey
    : DEFAULT_CAPTURE_HOTKEY
  if (prefs.captureHotkeyEnabled === false) {
    ballLog(`capture hotkey disabled by preferences (${accelerator})`)
    return
  }
  globalShortcut.unregisterAll()
  const registered = globalShortcut.register(accelerator, () => {
    ballLog(`capture hotkey pressed (${accelerator})`)
    // Surface a refusal in the log: a dead hotkey that says nothing anywhere is
    // the worst possible failure mode for the only entry point.
    void beginCapture().then((result) => {
      if (!result.ok) ballLog(`capture did not start: ${result.message}`)
    })
  })
  ballLog(registered
    ? `capture hotkey registered: ${accelerator}`
    : `capture hotkey NOT registered: another application owns ${accelerator}`)
}

ipcMain.handle('ball:capture', async () => {
  ballLog('capture requested')
  return await beginCapture()
})

ipcMain.handle('overlay:select', async (_event, payload) => {
  const { id, rect } = payload
  const frame = frozen.get(id)
  if (frame === undefined) {
    closeOverlays()
    restoreBall()
    return { ok: false, message: '选区所属的显示器已失效，请重新框选' }
  }
  // The renderer works in display-local pixels; the shutter needs virtual-desktop
  // coordinates, which is simply the display origin plus the local selection.
  const absolute = {
    x: frame.bounds.x + rect.x,
    y: frame.bounds.y + rect.y,
    width: rect.width,
    height: rect.height,
  }
  try {
    const capture = await captureSelection(absolute)
    closeOverlays()
    ballLog(`selection ${capture.width}x${capture.height} captured in ${capture.ms} ms (${capture.bytes} bytes)`)
    openAskWindow(capture.file, absolute)
    return { ok: true, file: capture.file }
  } catch (error) {
    ballLog(`selection capture failed: ${error.message}`)
    closeOverlays()
    restoreBall()
    return { ok: false, message: `截图失败：${error.message}` }
  }
})

ipcMain.handle('overlay:cancel', () => {
  closeOverlays()
  restoreBall()
  return { ok: true }
})

ipcMain.handle('ask:submit', async (event, payload) => {
  const entry = askEntryForEvent(event)
  if (entry === undefined) {
    ballLog('ask:submit ignored: the sending window is not tracked')
    return { ok: false, message: '这个提问窗口已经不在管理中了' }
  }
  const question = String(payload && payload.question ? payload.question : '').trim()
  const imagePath = String(payload && payload.imagePath ? payload.imagePath : '')
  if (imagePath === '') return { ok: false, message: '没有拿到图片路径' }
  // An empty question is allowed: the image alone is a valid prompt.
  const result = await submitToBridge(imagePath, question)
  if (result.ok) {
    // Only the submitting window goes away. Every other open question window
    // keeps its own entry, so it stays interactive and cancellable.
    closeAskWindow(entry)
    restoreBall()
    askBallToRender('submitted')
  }
  return result
})

ipcMain.handle('ask:cancel', (event) => {
  // A cancel can arrive after the entry is already gone (double cancel, or a
  // window that submitted while this message was in flight).
  const entry = askEntryForEvent(event)
  if (entry !== undefined) closeAskWindow(entry)
  restoreBall()
  return { ok: true }
})

ipcMain.handle('ball:hide', () => {
  hideBall()
  return { ok: true }
})

ipcMain.handle('ask:open-folder', () => {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true })
  shell.openPath(CAPTURE_DIR)
  return { ok: true }
})

// ── lifecycle ────────────────────────────────────────────────────────────────

// A second launch must not stack a second ball.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showBall()
  })

  app.whenReady().then(async () => {
    createBall()
    registerCaptureHotkey()
    // Compile the fast shutter now rather than on the first click: compiling
    // takes about a second, and paying it while the human is still reading the
    // screen is free.
    const ready = await ensureCaptureHelper()
    ballLog(`shutter ready: ${ready ? 'native helper' : 'powershell fallback'} (${CAPTURE_EXE})`)
  })

  app.on('window-all-closed', () => {
    // The ask window closing must not quit the ball.
    if (ballWindow === null) app.quit()
  })

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    closeOverlays()
  })
}
