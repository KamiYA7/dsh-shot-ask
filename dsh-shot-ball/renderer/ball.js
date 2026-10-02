/**
 * The ball's renderer.
 *
 * Two jobs: start a capture on a clean click, and move the window on a drag.
 *
 * Dragging is implemented here rather than with the CSS `-webkit-app-region:
 * drag` property, because a drag region makes Electron treat the window's mouse
 * input as a native move operation — which swallowed the click before it could
 * reach a listener. Manual dragging keeps clicks and drags distinguishable by
 * distance, and every step is logged to a file so the behaviour can be checked
 * without a human watching.
 *
 * The window is larger than the ball (the gutter hosts the toast), so main is
 * told to shrink the window's clickable region to the ball itself; the HTML
 * sets the gutter to `pointer-events: none` as well.
 */
const ball = document.getElementById('ball')
const hideButton = document.getElementById('hide')
const toast = document.getElementById('toast')

let toastTimer = null
let dragOrigin = null
let moved = 0
let suppressClick = false

function log(message) {
  // Fire-and-forget: logging must never block or throw into the capture path.
  try { window.shotBall.log(message) } catch { /* the bridge is gone; ignore */ }
}

function showToast(text, isError) {
  toast.textContent = text
  toast.classList.toggle('error', isError === true)
  toast.classList.add('show')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.classList.remove('show') }, 6000)
}

async function startCapture() {
  log('click -> starting capture')
  ball.classList.add('busy')
  // Immediate visible feedback: the native capture takes a moment, and a click
  // that looks like nothing happened is indistinguishable from a broken one.
  showToast('正在抓屏，稍候…', false)
  try {
    const result = await window.shotBall.capture()
    log(`capture returned: ${JSON.stringify(result)}`)
    if (result && result.ok !== true) showToast(result.message || '抓屏失败', true)
  } catch (error) {
    const text = error && error.message ? error.message : String(error)
    log(`capture threw: ${text}`)
    showToast(`抓屏失败：${text}`, true)
  } finally {
    ball.classList.remove('busy')
  }
}

// ── manual drag ──────────────────────────────────────────────────────────────

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target === hideButton) return
  dragOrigin = { x: event.screenX, y: event.screenY }
  moved = 0
  ball.setPointerCapture?.(event.pointerId)
})

ball.addEventListener('pointermove', (event) => {
  if (dragOrigin === null) return
  const dx = Math.round(event.screenX - dragOrigin.x)
  const dy = Math.round(event.screenY - dragOrigin.y)
  if (dx === 0 && dy === 0) return
  dragOrigin = { x: event.screenX, y: event.screenY }
  moved += Math.abs(dx) + Math.abs(dy)
  ball.style.cursor = 'grabbing'
  window.shotBall.moveBy(dx, dy)
})

ball.addEventListener('pointerup', (event) => {
  if (dragOrigin === null) return
  dragOrigin = null
  ball.style.cursor = ''
  ball.releasePointerCapture?.(event.pointerId)
  if (moved > 4) {
    // A drag is not a click: swallow the click event that follows it.
    suppressClick = true
    log(`drag finished, moved ${moved}px`)
  }
})

ball.addEventListener('click', (event) => {
  if (event.target === hideButton) return
  if (suppressClick) {
    suppressClick = false
    log('click suppressed (this was a drag)')
    return
  }
  startCapture()
})

ball.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  startCapture()
})

hideButton.addEventListener('click', (event) => {
  event.stopPropagation()
  log('hide requested')
  window.shotBall.hide()
})

window.shotBall.onBallState((payload) => {
  log(`ball state: ${payload.kind}`)
  if (payload.kind === 'submitted') showToast('已提交给 DSH，去看会话回复', false)
  if (payload.kind === 'capture-cancelled') {
    ball.classList.remove('busy')
    showToast('已取消截图', false)
  }
})

log('ball renderer ready')
