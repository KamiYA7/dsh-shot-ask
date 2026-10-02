/**
 * The question window: shows the saved capture, takes the question, and hands
 * both to main for submission into DSH. An empty question is legal — the image
 * alone is a valid prompt.
 */
const thumb = document.getElementById('thumb')
const pathLabel = document.getElementById('path')
const question = document.getElementById('question')
const submitButton = document.getElementById('submit')
const folderButton = document.getElementById('folder')
const cancelButton = document.getElementById('cancel')
const status = document.getElementById('status')

let imagePath = ''

function setStatus(text, kind) {
  status.textContent = text
  status.className = kind === undefined ? '' : kind
}

window.shotBall.onAskInit((payload) => {
  imagePath = payload.imagePath
  thumb.src = payload.imageUrl
  pathLabel.textContent = payload.imagePath
  question.focus()
  if (payload.bridge === null) {
    setStatus('没检测到 DSH 桥接，提交会失败；图片已存本地', 'warn')
  } else {
    setStatus('就绪')
  }
})

async function submit() {
  if (imagePath === '') { setStatus('还没拿到图片路径', 'error'); return }
  submitButton.disabled = true
  const busyLabel = question.value.trim() === '' ? '提交图片…' : '提交中…'
  setStatus(busyLabel)
  try {
    const result = await window.shotBall.submit(imagePath, question.value)
    if (result && result.ok === true) {
      setStatus(result.message || '已提交', '')
      return
    }
    setStatus((result && result.message) || '提交失败', 'error')
    submitButton.disabled = false
  } catch (error) {
    setStatus(`提交失败：${error && error.message ? error.message : error}`, 'error')
    submitButton.disabled = false
  }
}

submitButton.addEventListener('click', submit)
folderButton.addEventListener('click', () => window.shotBall.openFolder())
cancelButton.addEventListener('click', () => window.shotBall.cancelAsk())

question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    window.shotBall.cancelAsk()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.shotBall.cancelAsk()
})
