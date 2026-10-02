/**
 * One display's selection overlay.
 *
 * The window is exactly the size of its display and transparent, so the live
 * desktop is what the human sees; this layer only draws the veil and the marquee.
 * The screenshot is taken by main *after* the selection is known and after these
 * windows are hidden, which is why nothing has to be captured, encoded, or
 * transferred before the drag can start.
 *
 * This desktop runs at 96 DPI (verified: `Primary DPI X = 96`), so a CSS pixel
 * here is one pixel of the eventual capture and `clientX/clientY` needs no
 * scaling. The coordinates are display-local; main adds the display origin.
 */
const selection = document.getElementById('selection')
const sizeLabel = document.getElementById('size')
const hint = document.getElementById('hint')

let displayId = null
let start = null
let current = null
let committed = false

window.shotBall.onOverlayInit((payload) => {
  displayId = payload.id
})

function rectOf(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

function paint() {
  if (start === null || current === null) {
    selection.style.display = 'none'
    sizeLabel.classList.remove('show')
    return
  }
  const rect = rectOf(start, current)
  selection.style.display = 'block'
  selection.style.left = `${rect.x}px`
  selection.style.top = `${rect.y}px`
  selection.style.width = `${rect.width}px`
  selection.style.height = `${rect.height}px`
  if (rect.width >= 2 && rect.height >= 2) {
    sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
    sizeLabel.classList.add('show')
  }
}

function reset() {
  start = null
  current = null
  paint()
}

window.addEventListener('pointerdown', (event) => {
  if (event.button === 2) { cancel(); return }
  if (event.button !== 0) return
  committed = false
  start = { x: event.clientX, y: event.clientY }
  current = { ...start }
  hint.style.display = 'none'
  paint()
})

window.addEventListener('pointermove', (event) => {
  if (start === null || committed) return
  current = { x: event.clientX, y: event.clientY }
  paint()
})

window.addEventListener('pointerup', async (event) => {
  if (start === null || committed) return
  current = { x: event.clientX, y: event.clientY }
  const rect = rectOf(start, current)
  // A stray click is not a selection: treat it as "start over".
  if (rect.width < 5 || rect.height < 5) { reset(); return }
  committed = true
  selection.style.borderColor = '#7ef0a0'
  try {
    const result = await window.shotBall.select(displayId, rect)
    if (result && result.ok !== true) {
      sizeLabel.textContent = result.message || '截图失败'
      sizeLabel.classList.add('show')
    }
  } catch (error) {
    sizeLabel.textContent = `截图失败：${error && error.message ? error.message : error}`
    sizeLabel.classList.add('show')
  }
})

// Right-click, Esc, and context-menu all mean "abandon".
window.addEventListener('contextmenu', (event) => { event.preventDefault(); cancel() })
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); cancel() }
})

function cancel() {
  if (committed) return
  committed = true
  window.shotBall.cancelOverlay()
}
