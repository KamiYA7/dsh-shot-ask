/**
 * The one bridge between the three renderers and the main process.
 *
 * Every channel here is invoked by a window this app created for itself; nothing
 * is exposed to page content, and no remote or loadable page is ever rendered.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shotBall', {
  /** Start a capture: freeze the displays and open the selection overlays. */
  capture: () => ipcRenderer.invoke('ball:capture'),
  /** Switch the ball off (remembered across launches). */
  hide: () => ipcRenderer.invoke('ball:hide'),
  /** Nudge the ball window by a pointer delta (manual dragging). */
  moveBy: (dx, dy) => ipcRenderer.invoke('ball:move-by', { dx, dy }),
  /** Append one line to the shared log file, so a dead click is visible. */
  log: (message) => ipcRenderer.invoke('ball:log', message),

  /** Deliver one finished selection, in display-local pixels. */
  select: (id, rect) => ipcRenderer.invoke('overlay:select', { id, rect }),
  /** Abandon the in-flight capture. */
  cancelOverlay: () => ipcRenderer.invoke('overlay:cancel'),

  /** Send the question with the saved image to DSH. */
  submit: (imagePath, question) => ipcRenderer.invoke('ask:submit', { imagePath, question }),
  cancelAsk: () => ipcRenderer.invoke('ask:cancel'),
  openFolder: () => ipcRenderer.invoke('ask:open-folder'),

  /** main → renderer: the frozen frame this overlay must paint. */
  onOverlayInit: (handler) => {
    ipcRenderer.on('overlay:init', (_event, payload) => handler(payload))
  },
  /** main → renderer: the saved image and bridge state for the question window. */
  onAskInit: (handler) => {
    ipcRenderer.on('ask:init', (_event, payload) => handler(payload))
  },
  /** main → renderer: transient ball feedback. */
  onBallState: (handler) => {
    ipcRenderer.on('ball:state', (_event, payload) => handler(payload))
  },
})
