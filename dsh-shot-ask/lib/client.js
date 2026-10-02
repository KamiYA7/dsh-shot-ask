/**
 * Browser half of dsh-shot-ask — box-select the screen, type a question, and
 * deliver image + question to the composer in one action.
 *
 * Written in the lazy-CJS bundle protocol the client-modules scanner serves
 * (`window.__ModuleLoader__.load({ id, factory })`), so it needs no build step
 * and imports only the frozen platform table: react, react-dom,
 * react/jsx-runtime. Everything else is plain DOM.
 *
 * The image reaches the composer through DSH's own attachment intake: a
 * synthesized `drop` on `document` carrying a real `File`, which is the same
 * path a hand drag takes (`dataTransfer.types` includes `Files`). The question
 * follows as composer text, and the send button is pressed once the upload has
 * cleared — so the whole gesture is capture → select → type → Enter.
 *
 * Requires the route's model to accept image input. `deepseek-flash` does on
 * the wire; declare `inputModalities: [text, image]` for it in
 * `$DSH_HOME/settings.yaml` or the host rejects the image before sending.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shot-ask',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDom = require('react-dom')
    var jsx = require('react/jsx-runtime')

    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    /** Service keys this browser half consumes. */
    var inject = ['slots']

    // ── small DOM helpers ───────────────────────────────────────────────────

    /** True for a node the composer would accept typed text in. */
    function isEditable(el) {
      if (!el) return false
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true
      if (el.isContentEditable) return true
      var ce = el.getAttribute && el.getAttribute('contenteditable')
      return ce === 'true' || ce === '' || ce === 'plaintext-only'
    }

    /** Best guess at the composer's editor, preferring the scoped selectors. */
    function composerEditable() {
      var scoped = document.querySelector('[data-composer-card] textarea, [data-composer-card] [contenteditable="true"]')
      if (isEditable(scoped)) return scoped
      var phased = document.querySelector('textarea[data-phase], [contenteditable="true"][data-phase]')
      if (isEditable(phased)) return phased
      var nodes = document.querySelectorAll('textarea, [contenteditable="true"]')
      var best = null
      var bestArea = 0
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i]
        if (!isEditable(el)) continue
        var r = el.getBoundingClientRect()
        if (r.width < 60 || r.height < 20) continue
        var area = r.width * r.height
        if (area > bestArea) { bestArea = area; best = el }
      }
      return best
    }

    /**
     * Append text to the composer without clobbering an existing draft.
     * `execCommand` is what fires the `input` event React's controlled editor
     * listens for; the prototype setter is the fallback.
     */
    function appendComposerText(text) {
      var el = composerEditable()
      if (el === null) return false
      el.focus()
      var payload = text
      try {
        var existing = el.isContentEditable ? el.textContent || '' : el.value || ''
        if (existing.length > 0 && !/\s$/.test(existing)) payload = ' ' + text
      } catch { /* a read-only probe must not abort the insert */ }
      var inserted = false
      try { inserted = document.execCommand('insertText', false, payload) } catch { inserted = false }
      if (inserted) return true
      if (el.isContentEditable) {
        el.appendChild(document.createTextNode(payload))
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      var setter = Object.getOwnPropertyDescriptor(proto, 'value')
      if (setter === undefined || setter.set === undefined) return false
      setter.set.call(el, (el.value || '') + payload)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    /** The composer's primary action button, found by its stable aria-label. */
    function sendButton() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/^(send|发送|submit|提交|发送消息|排队发送|立即发送|发送并排队)/.test(label.trim())) return buttons[i]
      }
      var card = document.querySelector('[data-composer-card]')
      if (card === null) return null
      var scoped = card.querySelectorAll('button')
      for (var j = scoped.length - 1; j >= 0; j--) {
        var scopedLabel = scoped[j].getAttribute('aria-label') || ''
        if (/send|发送|提交/i.test(scopedLabel)) return scoped[j]
      }
      return null
    }

    /** Resolve after the send button is enabled, or give up quietly. */
    function pressSendWhenReady() {
      var waited = 0
      var step = 250
      var limit = 40000
      return new Promise(function (resolve) {
        function attempt() {
          var button = sendButton()
          if (button !== null && button.disabled !== true) {
            button.click()
            resolve(true)
            return
          }
          waited += step
          if (waited >= limit) { resolve(false); return }
          window.setTimeout(attempt, step)
        }
        window.setTimeout(attempt, step)
      })
    }

    /** data: URL → File, so the intake sees bytes exactly as a drag would. */
    async function dataUrlToFile(dataUrl, filename) {
      var blob = await (await fetch(dataUrl)).blob()
      return new File([blob], filename, { type: blob.type || 'image/png' })
    }

    /**
     * Deliver one PNG into the composer's draft through the official attachment
     * intake, then write the question and press send.
     * @returns a short human-readable outcome, for the overlay's status line.
     */
    async function deliver(dataUrl, question) {
      var file
      try {
        file = await dataUrlToFile(dataUrl, 'dsh-shot-ask.png')
      } catch (error) {
        return { ok: false, note: '图片编码失败：' + String(error && error.message ? error.message : error) }
      }
      try {
        var transfer = new DataTransfer()
        transfer.items.add(file)
        document.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }))
      } catch (error) {
        return { ok: false, note: '投递到输入框失败：' + String(error && error.message ? error.message : error) }
      }
      // The intake registers the draft attachment synchronously; give React one
      // frame before typing into the same editor.
      await new Promise(function (resolve) { window.setTimeout(resolve, 120) })
      if (question.length > 0 && !appendComposerText(question)) {
        return { ok: false, note: '图片已进输入框，但问题没能写入（请手动输入后回车）' }
      }
      var sent = await pressSendWhenReady()
      return sent
        ? { ok: true, note: '已发送' }
        : { ok: false, note: '图片与问题已在输入框，请手动按回车发送' }
    }

    // ── the preference store ────────────────────────────────────────────────
    //
    // Two independently registered surfaces share one preference: the settings
    // row that edits it and the floating ball that obeys it. A tiny module-local
    // store keeps them in step without either owning the other. `localStorage`
    // carries it across reloads — the client has no namespace-free settings
    // write path, and this is a UI preference, not deployment config.

    var STORE_KEY = 'dsh-shot-ask:preferences:v1'
    var preference = { floating: true, x: null, y: null }
    var preferenceListeners = new Set()

    function loadPreferences() {
      try {
        var raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return
        var parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          if (typeof parsed.floating === 'boolean') preference.floating = parsed.floating
          if (typeof parsed.x === 'number') preference.x = parsed.x
          if (typeof parsed.y === 'number') preference.y = parsed.y
        }
      } catch (error) {
        // A blocked or corrupt store must not break the plugin: defaults stand.
      }
    }

    function savePreferences() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(preference))
      } catch (error) {
        // Private-mode refusal is survivable: the preference lives for this page.
      }
    }

    function setPreference(patch) {
      Object.assign(preference, patch)
      savePreferences()
      preferenceListeners.forEach(function (listener) { listener() })
    }

    /** Subscribe a component to preference changes. */
    function usePreferences() {
      var versionState = useState(0)
      var setVersion = versionState[1]
      useEffect(function () {
        var listener = function () { setVersion(function (value) { return value + 1 }) }
        preferenceListeners.add(listener)
        return function () { preferenceListeners.delete(listener) }
      }, [])
      return preference
    }

    loadPreferences()

    // ── overlay UI ──────────────────────────────────────────────────────────

    /** The dimmed full-screen selection surface plus its frozen screenshot. */
    var overlayStyle = {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483000',
      cursor: 'crosshair',
      background: 'rgba(0,0,0,0.35)',
      userSelect: 'none',
      touchAction: 'none',
    }

    /** The host route that captures this screen natively. */
    var HOST_CAPTURE_PATH = '/dsh-shot-ask/capture.png'

    /** Read a fetched PNG blob into a data URL the overlay can paint and crop. */
    function blobToDataUrl(blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader()
        reader.onload = function () { resolve(reader.result) }
        reader.onerror = function () { reject(new Error('读取截图失败')) }
        reader.readAsDataURL(blob)
      })
    }

    function rectOf(a, b) {
      var x = Math.min(a.x, b.x)
      var y = Math.min(a.y, b.y)
      return { x: x, y: y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
    }

    /** The question panel shown once a region is frozen. */
    function QuestionPanel(props) {
      var ref = useRef(null)
      var questionState = useState('')
      var question = questionState[0]
      var setQuestion = questionState[1]
      var busyState = useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noteState = useState('')
      var note = noteState[0]
      var setNote = noteState[1]

      useEffect(function () {
        if (ref.current !== null) ref.current.focus()
      }, [])

      var submit = useCallback(function (text) {
        if (busy !== null) return
        var finalText = (text !== undefined ? text : question).trim()
        setBusy('sending')
        setNote('正在投递…')
        deliver(props.dataUrl, finalText).then(function (result) {
          setBusy(null)
          setNote(result.note)
          if (result.ok) props.onDone()
        }, function (error) {
          setBusy(null)
          setNote('失败：' + String(error && error.message ? error.message : error))
        })
      }, [busy, question, props])

      var presets = ['这是什么？', '解释一下这段内容', '这里有什么问题？', '帮我翻译成中文']
      var children = [
        h('div', { key: 'title', style: { fontWeight: '600', marginBottom: '6px' } }, '框选已就绪 — 输入问题后回车即发送'),
        h('div', {
          key: 'presets',
          style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' },
        }, presets.map(function (preset) {
          return h('button', {
            key: preset,
            type: 'button',
            disabled: busy !== null,
            onClick: function () { submit(preset) },
            style: {
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(127,127,127,0.45)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            },
          }, preset)
        })),
        h('textarea', {
          key: 'input',
          ref: ref,
          value: question,
          rows: 2,
          placeholder: '想问什么？（可留空，直接发送图片）',
          disabled: busy !== null,
          onChange: function (event) { setQuestion(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              props.onCancel()
            }
          },
          style: {
            width: '100%',
            resize: 'vertical',
            padding: '8px',
            borderRadius: '6px',
            border: '1px solid rgba(127,127,127,0.45)',
            background: 'rgba(0,0,0,0.25)',
            color: 'inherit',
            font: 'inherit',
            boxSizing: 'border-box',
          },
        }),
        h('div', {
          key: 'foot',
          style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' },
        }, [
          h('button', {
            key: 'send',
            type: 'button',
            disabled: busy !== null,
            onClick: function () { submit() },
            style: {
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              background: '#4f7cff',
              color: '#fff',
              cursor: busy !== null ? 'default' : 'pointer',
              fontWeight: '600',
            },
          }, busy !== null ? '发送中…' : '发送提问'),
          h('button', {
            key: 'redo',
            type: 'button',
            disabled: busy !== null,
            onClick: props.onRedo,
            style: {
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(127,127,127,0.45)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            },
          }, '重选'),
          h('button', {
            key: 'esc',
            type: 'button',
            disabled: busy !== null,
            onClick: props.onCancel,
            style: {
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(127,127,127,0.45)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            },
          }, '取消 (Esc)'),
          h('span', {
            key: 'note',
            style: { fontSize: '12px', opacity: '0.8', marginLeft: 'auto' },
          }, note),
        ]),
      ]
      return h('div', {
        style: {
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: '24px',
          zIndex: '2147483002',
          minWidth: '420px',
          maxWidth: 'min(720px, 92vw)',
          padding: '14px',
          borderRadius: '10px',
          background: 'rgba(24,24,28,0.97)',
          color: '#e8e8ea',
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        },
      }, children)
    }

    /** Full capture flow: pick a screen, box-select, freeze, then ask. */
    function ShotAskOverlay(props) {
      var videoRef = useRef(null)
      var [stream, setStream] = useState(null)
      var [error, setError] = useState('')
      var [drag, setDrag] = useState(null)
      var [frozen, setFrozen] = useState(null)
      var [still, setStill] = useState(null)
      var stillImageRef = useRef(null)

      // Acquire the screen. The host route comes first because the Desktop shell
      // answers getDisplayMedia with an empty grant and denies every permission
      // request, so a Desktop window can never acquire a display stream. A plain
      // browser without that route keeps the picker.
      useEffect(function () {
        var cancelled = false

        function viaDisplayMedia() {
          var media = navigator.mediaDevices
          if (media === undefined || typeof media.getDisplayMedia !== 'function') {
            setError('这台机器既没有本地抓屏通道，浏览器也不支持 getDisplayMedia，无法截图。')
            return
          }
          media.getDisplayMedia({ video: { frameRate: 30 }, audio: false }).then(function (acquired) {
            if (cancelled) {
              acquired.getTracks().forEach(function (track) { track.stop() })
              return
            }
            setStream(acquired)
          }, function () {
            if (!cancelled) setError('已取消屏幕选择。')
          })
        }

        fetch(HOST_CAPTURE_PATH, { headers: { accept: 'image/png' } }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.blob()
        }).then(blobToDataUrl).then(function (dataUrl) {
          if (!cancelled) setStill(dataUrl)
        }, function () {
          if (!cancelled) viaDisplayMedia()
        })

        return function () {
          cancelled = true
        }
      }, [])

      // Decode the captured still so the crop reads its exact pixel dimensions.
      useEffect(function () {
        if (still === null) { stillImageRef.current = null; return }
        var image = new Image()
        image.onload = function () { stillImageRef.current = image }
        image.src = still
      }, [still])

      // Attach the stream to the hidden <video> the crop reads from.
      useEffect(function () {
        var video = videoRef.current
        if (video === null || stream === null) return
        video.srcObject = stream
        video.muted = true
        var played = video.play()
        if (played !== undefined && played.catch !== undefined) played.catch(function () { /* autoplay refusal surfaces as a frozen frame */ })
      }, [stream])

      var finish = useCallback(function (rect) {
        var video = videoRef.current
        var stillImage = stillImageRef.current
        if (rect.w < 4 || rect.h < 4) { setDrag(null); return }
        if (video === null && stillImage === null) { setDrag(null); return }
        var vw = stillImage !== null ? stillImage.naturalWidth : (video.videoWidth || window.innerWidth)
        var vh = stillImage !== null ? stillImage.naturalHeight : (video.videoHeight || window.innerHeight)
        var sx = vw / window.innerWidth
        var sy = vh / window.innerHeight
        var canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(rect.w * sx))
        canvas.height = Math.max(1, Math.round(rect.h * sy))
        var ctx2d = canvas.getContext('2d')
        ctx2d.drawImage(
          stillImage !== null ? stillImage : video,
          Math.round(rect.x * sx), Math.round(rect.y * sy), canvas.width, canvas.height,
          0, 0, canvas.width, canvas.height,
        )
        setDrag(null)
        setFrozen(canvas.toDataURL('image/png'))
      }, [])

      var stopStream = useCallback(function () {
        if (stream !== null) stream.getTracks().forEach(function (track) { track.stop() })
      }, [stream])

      var close = useCallback(function () {
        stopStream()
        props.onClose()
      }, [stopStream, props])

      var onDown = useCallback(function (event) {
        if (frozen !== null) return
        var point = { x: event.clientX, y: event.clientY }
        setDrag({ start: point, current: point })
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }, [frozen])

      var onMove = useCallback(function (event) {
        if (drag === null) return
        setDrag({ start: drag.start, current: { x: event.clientX, y: event.clientY } })
      }, [drag])

      var onUp = useCallback(function () {
        if (drag === null) return
        finish(rectOf(drag.start, drag.current))
      }, [drag, finish])

      var escaped = useCallback(function (event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (frozen !== null) { setFrozen(null); return }
          close()
        }
      }, [frozen, close])

      useEffect(function () {
        window.addEventListener('keydown', escaped, true)
        return function () { window.removeEventListener('keydown', escaped, true) }
      }, [escaped])

      var layers = [
        h('video', { key: 'video', ref: videoRef, style: { display: 'none' } }),
      ]

      if (error !== '') {
        layers.push(h('div', {
          key: 'error',
          style: {
            position: 'fixed', left: '50%', top: '40%', transform: 'translate(-50%,-50%)',
            zIndex: '2147483002', padding: '14px 18px', borderRadius: '10px',
            background: 'rgba(24,24,28,0.97)', color: '#e8e8ea', font: '13px system-ui, sans-serif',
            maxWidth: '480px', textAlign: 'center',
          },
        }, [h('div', { key: 'msg' }, error), h('button', {
          key: 'ok', type: 'button', onClick: close,
          style: { marginTop: '10px', padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#4f7cff', color: '#fff', cursor: 'pointer' },
        }, '关闭')]))
      }

      if (error === '' && frozen === null) {
        var rect = drag === null ? null : rectOf(drag.start, drag.current)
        layers.push(h('div', {
          key: 'surface',
          // Paint the captured screen when we have one: the crop maps the image
          // onto the viewport 1:1, so the backdrop matches the selection exactly.
          style: still === null ? overlayStyle : Object.assign({}, overlayStyle, {
            background: 'rgba(0,0,0,0.15) url(' + still + ') center/100% 100% no-repeat',
          }),
          onPointerDown: onDown,
          onPointerMove: onMove,
          onPointerUp: onUp,
        }, [
          h('div', {
            key: 'hint',
            style: {
              position: 'fixed', left: '50%', top: '16px', transform: 'translateX(-50%)',
              padding: '6px 12px', borderRadius: '999px', background: 'rgba(0,0,0,0.7)',
              color: '#fff', font: '12px system-ui, sans-serif', pointerEvents: 'none',
            },
          }, still === null && stream === null ? '正在抓取屏幕…' : '拖动鼠标框选要提问的区域（Esc 取消）'),
          rect === null ? null : h('div', {
            key: 'rect',
            style: {
              position: 'fixed',
              left: rect.x + 'px',
              top: rect.y + 'px',
              width: rect.w + 'px',
              height: rect.h + 'px',
              border: '1px solid #4f7cff',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
              pointerEvents: 'none',
            },
          }),
        ]))
      }

      if (frozen !== null) {
        layers.push(h('img', {
          key: 'frozen',
          src: frozen,
          alt: '',
          style: {
            position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
            maxWidth: '70vw', maxHeight: '60vh', zIndex: '2147483001',
            border: '1px solid rgba(127,127,127,0.6)', borderRadius: '8px',
            background: '#111',
          },
        }))
        layers.push(h(QuestionPanel, {
          key: 'panel',
          dataUrl: frozen,
          onDone: close,
          onRedo: function () { setFrozen(null) },
          onCancel: close,
        }))
      }

      return h(React.Fragment, null, layers)
    }

    /** The composer's capture button. */
    function ShotAskButton() {
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var toggle = useCallback(function () { setOpen(function (value) { return !value }) }, [])
      var close = useCallback(function () { setOpen(false) }, [])

      return h(React.Fragment, null, [
        h('button', {
          key: 'button',
          type: 'button',
          'aria-label': '框选截图提问',
          title: '框选截图并提问（截图后输入问题，回车即发送）',
          onClick: toggle,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: '28px', height: '28px', padding: '0',
            border: 'none', background: 'transparent', color: 'inherit',
            cursor: 'pointer', borderRadius: '6px',
          },
        }, cameraIcon(16)),
        open ? ReactDom.createPortal(h(ShotAskOverlay, { onClose: close }), document.body) : null,
      ])
    }

    /** The capture mark, shared by the composer seat and the floating ball. */
    function cameraIcon(size) {
      return h('svg', {
        viewBox: '0 0 16 16', width: String(size), height: String(size),
        'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4',
      }, [
        h('path', { key: 'body', d: 'M1.5 5.2V3.6A2.1 2.1 0 0 1 3.6 1.5h1.6' }),
        h('path', { key: 'body2', d: 'M14.5 10.8v1.6a2.1 2.1 0 0 1-2.1 2.1h-1.6' }),
        h('path', { key: 'body3', d: 'M5.2 14.5H3.6a2.1 2.1 0 0 1-2.1-2.1v-1.6' }),
        h('path', { key: 'body4', d: 'M10.8 1.5h1.6a2.1 2.1 0 0 1 2.1 2.1v1.6' }),
        h('circle', { key: 'lens', cx: '8', cy: '8', r: '2.6' }),
      ])
    }

    /** One shared capture session, opened from either surface. */
    function CaptureSession(props) {
      return ReactDom.createPortal(h(ShotAskOverlay, { onClose: props.onClose }), document.body)
    }

    /**
     * The floating capture ball.
     *
     * Registration rides `sidebar.footer.action` — the only always-mounted
     * root-scope seat a plugin can claim — but the ball itself is a
     * `position: fixed` element teleported to `document.body`, so it floats
     * over the whole viewport instead of sitting in the sidebar's layout.
     * Position is dragged and remembered (localStorage), and the corner ×
     * switches the widget off, which the settings row switches back on.
     */
    function FloatingCaptureBall() {
      var prefs = usePreferences()
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      // Guards the click that ends a drag from also opening the overlay.
      var draggedRef = useRef(false)

      var startDrag = useCallback(function (event) {
        if (event.button !== 0) return
        var origin = { x: event.clientX, y: event.clientY }
        var startX = prefs.x === null ? window.innerWidth - 84 : prefs.x
        var startY = prefs.y === null ? window.innerHeight - 140 : prefs.y
        draggedRef.current = false
        var previousCursor = document.body.style.cursor

        function onMove(moveEvent) {
          var dx = moveEvent.clientX - origin.x
          var dy = moveEvent.clientY - origin.y
          if (!draggedRef.current && Math.abs(dx) + Math.abs(dy) < 4) return
          draggedRef.current = true
          document.body.style.cursor = 'grabbing'
          var size = 44
          var maxX = Math.max(0, window.innerWidth - size)
          var maxY = Math.max(0, window.innerHeight - size)
          setPreference({
            x: Math.min(maxX, Math.max(0, startX + dx)),
            y: Math.min(maxY, Math.max(0, startY + dy)),
          })
        }

        function onUp() {
          document.body.style.cursor = previousCursor
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (draggedRef.current) savePreferences()
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        event.preventDefault()
      }, [prefs.x, prefs.y])

      var onBallClick = useCallback(function () {
        if (draggedRef.current) { draggedRef.current = false; return }
        setOpen(true)
      }, [])

      var hideBall = useCallback(function (event) {
        event.stopPropagation()
        setPreference({ floating: false })
      }, [])

      if (!prefs.floating) return null

      var style = {
        position: 'fixed',
        left: (prefs.x === null ? window.innerWidth - 84 : prefs.x) + 'px',
        top: (prefs.y === null ? window.innerHeight - 140 : prefs.y) + 'px',
        width: '44px',
        height: '44px',
        zIndex: '2147482000',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        touchAction: 'none',
        userSelect: 'none',
        color: '#fff',
        background: 'linear-gradient(145deg, #5b86ff, #3556d8)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        border: '1px solid rgba(255,255,255,0.22)',
      }

      var ball = h('div', {
        'data-dsh-shot-ask-ball': '',
        style: style,
        role: 'button',
        tabIndex: 0,
        'aria-label': '悬浮截图提问',
        title: '点击框选截图提问；拖动可移动位置',
        onPointerDown: startDrag,
        onClick: onBallClick,
        onKeyDown: function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        },
      }, [
        cameraIcon(20),
        h('span', {
          key: 'hide',
          role: 'button',
          tabIndex: -1,
          'aria-label': '关闭悬浮窗（可在设置里重新打开）',
          title: '关闭悬浮窗（设置里可重新打开）',
          onClick: hideBall,
          onPointerDown: function (event) { event.stopPropagation() },
          style: {
            position: 'absolute',
            right: '-4px',
            top: '-4px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: 'rgba(20,20,24,0.92)',
            color: '#fff',
            fontSize: '11px',
            lineHeight: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.3)',
          },
        }, '×'),
      ])

      return h(React.Fragment, null, [
        ReactDom.createPortal(ball, document.body),
        open ? h(CaptureSession, { key: 'session', onClose: function () { setOpen(false) } }) : null,
      ])
    }

    /**
     * The General-settings row that owns the floating widget's switch and shows
     * where captures land. The section supplies no props and no label projection,
     * so the row draws its own copy and reads the same module-local preference the
     * ball obeys.
     *
     * This row is the plugin's whole settings surface: the capture directory, the
     * bridge self-check, and the floating widget's switch. The desktop ball reads
     * the same directory and the same bridge file, so a mismatch between the two
     * halves is visible here rather than only in a log.
     */
    function ShotAskSettingsRow() {
      var prefs = usePreferences()
      var infoState = useState(null)
      var info = infoState[0]
      var setInfo = infoState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]

      useEffect(function () {
        // Same-origin fetch: this browser half has no host bridge object, and the
        // host half of this same plugin serves these two read-only routes.
        fetch('/dsh-shot-ask/info', { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(setInfo, function (error) {
            setInfo({ error: String(error && error.message ? error.message : error) })
          })
      }, [])

      var toggle = useCallback(function () {
        setPreference({ floating: !prefs.floating })
      }, [prefs.floating])

      // A web page cannot open a native folder, so this copies the path instead;
      // Explorer is one paste away and nothing here needs a shell.
      var copyPath = useCallback(function () {
        var dir = info && info.captureDir ? info.captureDir : ''
        if (dir === '') return
        try {
          navigator.clipboard.writeText(dir)
          setBusy('已复制路径')
          window.setTimeout(function () { setBusy('') }, 1500)
        } catch (error) {
          setBusy('复制失败')
        }
      }, [info])

      var testBridge = useCallback(function () {
        setBusy('测试中…')
        fetch('/dsh-shot-ask/bridge-test', { headers: { accept: 'application/json' } })
          .then(function (response) { return response.json() })
          .then(function (result) {
            setBusy('')
            setInfo(function (previous) {
              return Object.assign({}, previous, { bridge: result })
            })
          }, function (error) {
            setBusy('')
            setInfo(function (previous) {
              return Object.assign({}, previous, { bridge: { ok: false, message: String(error && error.message ? error.message : error) } })
            })
          })
      }, [])

      var bridge = info && info.bridge
      var bridgeText = bridge === undefined
        ? (info && info.bridgeConfigured ? 'DSH 桥接：已配置' : 'DSH 桥接：未找到配置')
        : (bridge.ok ? `DSH 桥接：可用${bridge.sessions === undefined ? '' : `（${bridge.sessions} 个活跃会话）`}` : `DSH 桥接：不可用 — ${bridge.message}`)

      var buttonStyle = {
        padding: '5px 10px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.4)', background: 'transparent',
        color: 'inherit', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
      }

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '12px 0', borderTop: '1px solid rgba(127,127,127,0.18)',
          font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        },
      }, [
        // Row 1: the floating ball switch.
        h('div', { key: 'row1', style: { display: 'flex', alignItems: 'center', gap: '16px' } }, [
          h('div', { key: 'copy', style: { flex: '1 1 auto', minWidth: '0' } }, [
            h('div', { key: 'name', style: { fontWeight: '600' } }, '悬浮截图提问'),
            h('div', {
              key: 'desc',
              style: { opacity: '0.72', marginTop: '2px' },
            }, '显示一个可拖动的悬浮球，点它即可框选屏幕区域并提问；位置会被记住。关闭后可用本开关重新打开。'),
          ]),
          h('div', { key: 'control', style: { flex: '0 0 auto' } }, h('label', {
            style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
          }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: prefs.floating === true,
              onChange: toggle,
            }),
            h('span', { key: 'label' }, prefs.floating === true ? '已开启' : '已关闭'),
          ])),
        ]),
        // Row 2: where captures land, and whether the bridge answers.
        h('div', { key: 'row2', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
          h('div', {
            key: 'path',
            style: {
              flex: '1 1 240px', minWidth: '0', opacity: '0.8',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              direction: 'rtl', textAlign: 'left',
            },
            title: info && info.captureDir ? info.captureDir : '',
          }, info === null ? '正在读取截图目录…' : (info.captureDir || info.error || '—')),
          h('span', {
            key: 'bridge',
            style: {
              flex: '0 0 auto', fontSize: '12px',
              color: bridge !== undefined && bridge.ok !== true ? '#ffb1b1' : 'inherit',
              opacity: bridge !== undefined && bridge.ok !== true ? '1' : '0.72',
            },
          }, bridgeText),
          h('button', { key: 'open', type: 'button', style: buttonStyle, onClick: copyPath }, '复制截图目录'),
          h('button', {
            key: 'test', type: 'button', style: buttonStyle, onClick: testBridge,
            disabled: busy !== '',
          }, busy === '' ? '测试桥接' : busy),
        ]),
      ])
    }

    /** Register the composer seat, the floating ball, and the settings row. */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-shot-ask',
          order: -9,
        }, ShotAskButton)
      })
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-shot-ask-ball',
          order: -20,
        }, FloatingCaptureBall)
      })
      ctx.slots.inject('settings.general.item', function () {
        return ctx.slots.register({
          name: 'settings.general.item',
          id: 'dsh-shot-ask-row',
          order: -20,
        }, ShotAskSettingsRow)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.ShotAskButton = ShotAskButton
    exports.FloatingCaptureBall = FloatingCaptureBall
    exports.ShotAskSettingsRow = ShotAskSettingsRow
    return module.exports
  },
})
