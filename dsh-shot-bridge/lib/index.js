/**
 * dsh-shot-bridge — admit a desktop capture into a DSH session.
 *
 * Why this exists: the desktop capture ball is a process outside the browser, and
 * the only authenticated ingress into a running `dsh web` is the browser's signed
 * cookie (minted by exchanging the launch token at `/`). There is no API-key path,
 * and a draft attachment cannot be minted from outside the page
 * (`DraftAttachmentId` is browser-owned). So the supported way in is from inside
 * the host: this plugin admits the prompt directly through the Agent's public
 * inbox API.
 *
 * Transport: one POST route on the existing `webServer`, guarded by a shared
 * secret this plugin mints on activation and writes next to the Harness home.
 * The route is loopback-only in practice because the web surface binds loopback.
 *
 * Prompt shape: `createUserMessage` + `agent.followup`, which is the same pair the
 * Session Remote's `prompt` command uses (`commands.ts`, `admit`): text first,
 * then the image block, so the model reads the question with the picture in hand.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-shot-bridge'

/**
 * Every service this plugin touches must be declared, because `inject` is read
 * once when the plugin is mounted and is never re-evaluated on a source edit:
 *
 * - `webServer`  — hosts the two routes (it opens no port of its own).
 * - `agents`     — the Agent registry the prompt is admitted into.
 * - `attachments`— promotes raw image bytes to a durable attachment reference.
 * - `llm`        — `resolveModelInfo` answers whether the route accepts images.
 * - `agentDefaultModel` — supplies the current provider/model selection. The
 *   per-session selection lives on the session controller's private agent
 *   controller, not on the public `ctx.agents`, so this is where it must be read.
 */
export const inject = ['webServer', 'agents', 'attachments', 'llm', 'agentDefaultModel']

const ROUTE_PATH = '/dsh-shot-bridge/submit'
const HEALTH_PATH = '/dsh-shot-bridge/health'

/** Decoded-byte ceiling for one capture. A 4K region PNG sits far under this. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * The ball checkout this bridge starts; override with `DSH_SHOT_BALL_DIR`.
 *
 * The default is the sibling directory of this package inside the repository,
 * so a clone works wherever it lands.
 */
const BALL_DIR = process.env.DSH_SHOT_BALL_DIR
  ?? path.resolve(import.meta.dirname, '..', '..', 'dsh-shot-ball')
const BALL_ELECTRON = path.join(BALL_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
/** The shipped launcher; the bridge starts the ball through this, not Electron. */
const BALL_CMD = path.join(BALL_DIR, 'start-ball.cmd')

/**
 * Start the desktop capture ball alongside this DSH instance.
 *
 * The ball hosts the global capture hotkey, so it has to be running for that
 * hotkey to exist; starting it here ties the ball to DSH instead of to an OS
 * login item. `DSH_HOME` is passed explicitly because each Harness home
 * publishes its own port and token to `dsh-shot-bridge.json`, and the ball
 * submits to whichever home its own environment names. The ball holds a
 * single-instance lock, so an already-running ball is left as it is.
 * Set `DSH_SHOT_BALL_AUTOSTART=0` to skip this.
 * @param ctx - plugin context, used only for the start/skip log lines.
 */
function launchBall(ctx) {
  // On by default: opening DSH brings the ball up, which is the whole point of
  // the hotkey. Set DSH_SHOT_BALL_AUTOSTART=0 to launch start-ball.cmd yourself.
  if (process.env.DSH_SHOT_BALL_AUTOSTART === '0') {
    ctx.logger?.info?.('[dsh-shot-bridge] ball autostart disabled (DSH_SHOT_BALL_AUTOSTART=0)')
    return
  }
  if (process.platform !== 'win32') return
  if (!fs.existsSync(BALL_CMD)) {
    ctx.logger?.warn?.('[dsh-shot-bridge] ball autostart skipped: %s is missing', BALL_CMD)
    return
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    // The DSH host itself runs in Electron's Node mode, and that flag is
    // inherited by every child. Handing it to the ball would start it as plain
    // Node, where `require('electron').app` is undefined and `app.setPath`
    // throws before any window exists.
    const env = { ...process.env, DSH_HOME: home }
    delete env.ELECTRON_RUN_AS_NODE
    // Launch the shipped script through the shell rather than calling Electron
    // directly. Children of the DSH host run inside its process tree, where a
    // directly spawned Electron starts, logs, registers its hotkey — and never
    // creates a window. The script is also what a human double-clicks when the
    // ball works, so this keeps the automated path identical to the known-good
    // one instead of merely resembling it.
    // Deliberately NOT detached: the ball belongs to this DSH instance, so the
    // DSH process-tree teardown takes it down when DSH exits. A detached ball
    // would outlive the bridge that feeds it and float there uselessly.
    const child = spawn(BALL_CMD, [], {
      cwd: BALL_DIR,
      stdio: 'ignore',
      windowsHide: false,
      shell: true,
      env,
    })
    child.unref()
    ctx.logger?.info?.('[dsh-shot-bridge] launched the capture ball (%s) for DSH_HOME=%s', BALL_DIR, home)
  } catch (error) {
    ctx.logger?.warn?.('[dsh-shot-bridge] could not launch the capture ball: %s', String(error))
  }
}

/** Where the ball looks for the port and secret. */
function bridgeFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-shot-bridge.json')
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The desktop ball's renderer runs from a `file://` origin, so its fetch to this
 * loopback route is cross-origin. A custom request header (`x-dsh-shot-token`)
 * therefore triggers a CORS preflight, and answering that preflight is what keeps
 * the submission from dying as an HTTP 405 before the POST is ever sent. The POST
 * path also accepts the token in the query string, which avoids the preflight
 * entirely; the header stays supported for curl and other non-browser callers.
 *
 * Scope: the route lives only on the loopback-bound web surface and the token is
 * still required, so `access-control-allow-origin: *` widens nothing beyond the
 * local machine. Do not expose this DSH to a network.
 */
function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-dsh-shot-token',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  })
  res.end(body)
}

/** Answer a CORS preflight, so the browser proceeds to the real POST. */
function respondPreflight(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-dsh-shot-token',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-max-age': '600',
  })
  res.end()
}

/**
 * Read the shared secret from either the header or the query string.
 * @param req - the incoming request.
 * @param url - the parsed request URL.
 * @returns the presented token, or an empty string.
 */
function presentedToken(req, url) {
  const header = req.headers['x-dsh-shot-token']
  if (typeof header === 'string' && header.length > 0) return header
  return url.searchParams.get('token') ?? ''
}

/**
 * Pick the session a capture should land in.
 *
 * ── Why the registry order is not enough ─────────────────────────────────────
 * `ctx.agents.list()` returns live Agents in the registry's own order, and taking
 * the first one sent captures to whichever session happened to be created first —
 * not the one the human is looking at. Observed consequence: a capture landed in
 * an untitled session while the conversation on screen never received it.
 *
 * ── How the target is chosen now ────────────────────────────────────────────
 * The bridge subscribes to `session/event` and keeps each session's newest event
 * time, so "the session you are actually using" is the one whose event stream
 * moved most recently — the session you just typed in, versus one idle for hours.
 * An explicit `sessionId` (or the `DSH_SHOT_TARGET_SESSION` environment variable)
 * always wins, which is the escape hatch when the guess is wrong.
 *
 * @param ctx - host context carrying the Agent registry.
 * @param requested - optional SessionId from the request body.
 * @param activity - sessionId → newest observed event time.
 * @returns the agent to admit into, or undefined when no session is live.
 */
function resolveTargetAgent(ctx, requested, activity, userActivity) {
  if (typeof requested === 'string' && requested.length > 0) {
    const explicit = ctx.agents.get(requested)
    if (explicit !== undefined) return explicit
  }
  const pinned = process.env.DSH_SHOT_TARGET_SESSION
  if (typeof pinned === 'string' && pinned.length > 0) {
    const pinnedAgent = ctx.agents.get(pinned)
    if (pinnedAgent !== undefined) return pinnedAgent
  }
  const live = ctx.agents.list()
  // The conversation the human last typed into wins; only when no session has
  // ever seen a user message does the any-event ranking apply, so a deployment
  // without one still reaches whatever is running.
  for (const source of [userActivity, activity]) {
    let newest = null
    let newestAt = -1
    for (const agent of live) {
      const seen = source.get(agent.id)
      if (seen !== undefined && seen > newestAt) {
        newestAt = seen
        newest = agent
      }
    }
    if (newest !== null) return newest
  }
  for (const agent of live) {
    if (agent.status === 'running' || agent.status === 'idle') return agent
  }
  return live[0]
}

/**
 * Mount the bridge and publish its coordinates.
 * @param ctx - plugin context carrying the injected services.
 */
export function apply(ctx) {
  const secret = randomUUID()
  let published = null

  const buildImageBlock = (image) => {
    if (image === null || typeof image !== 'object') throw new Error('image payload is missing')
    const mediaType = String(image.mediaType || 'image/png').toLowerCase()
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      throw new Error(`unsupported image media type "${mediaType}"`)
    }
    const data = String(image.data || '')
    if (data.length === 0) throw new Error('image payload carries no bytes')
    // Base64 inflates by 4/3; check the decoded size, not the encoded length.
    const decodedBytes = Math.floor((data.length * 3) / 4)
    if (decodedBytes > MAX_IMAGE_BYTES) {
      throw new Error(`image is ${decodedBytes} bytes, over the ${MAX_IMAGE_BYTES} byte ceiling`)
    }
    return {
      type: 'image',
      mediaType,
      data,
      ...(typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {}),
    }
  }

  // sessionId → newest event time seen (any event), the fallback ranking input.
  const activity = new Map()
  // sessionId → newest USER message time. A capture belongs to the conversation
  // the human last typed into, so this outranks the any-event map: a background
  // session that merely kept working must not steal the capture.
  const userActivity = new Map()

  // `ctx.on` is an effect, so Cordis unwinds the subscription when this plugin
  // unloads.
  ctx.on('session/event', (session, event) => {
    const at = typeof event?.time === 'number' ? event.time : Date.now()
    const id = session?.id
    if (typeof id !== 'string') return
    const previous = activity.get(id)
    if (previous === undefined || at >= previous) activity.set(id, at)
    if (typeof event?.type === 'string' && event.type.startsWith('user/')) {
      const previousUser = userActivity.get(id)
      if (previousUser === undefined || at >= previousUser) userActivity.set(id, at)
    }
  })

  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: (req, res) => {
      if (req.method === 'OPTIONS') { respondPreflight(res); return }
      if (req.method !== 'GET') { respond(res, 405, { error: 'use GET' }); return }
      const target = resolveTargetAgent(ctx, undefined, activity, userActivity)
      respond(res, 200, {
        ok: true,
        plugin: name,
        // Which session a capture would land in right now, and why.
        targetSessionId: target === undefined ? null : target.id,
        pinned: process.env.DSH_SHOT_TARGET_SESSION ?? null,
        sessions: ctx.agents.list().map((agent) => ({
          id: agent.id,
          status: agent.status,
          lastEventAt: activity.has(agent.id) ? new Date(activity.get(agent.id)).toISOString() : null,
        })),
      })
    },
  })

  const disposeSubmit = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'OPTIONS') { respondPreflight(res); return }
        if (req.method !== 'POST') { respond(res, 405, { error: 'use POST' }); return }
        if (presentedToken(req, url) !== secret) {
          respond(res, 401, { error: 'bad or missing token (x-dsh-shot-token header or ?token=)' })
          return
        }
        let request = null
        try {
          request = JSON.parse(await readBody(req, MAX_IMAGE_BYTES + 1024 * 1024))
        } catch (error) {
          respond(res, 400, { error: `unreadable JSON body: ${error.message}` })
          return
        }
        try {
          const agent = resolveTargetAgent(ctx, request.sessionId, activity, userActivity)
          if (agent === undefined) {
            respond(res, 409, {
              error: '没有活着的 DSH 会话可以注入；先打开一个会话再试。',
            })
            return
          }
          const question = typeof request.question === 'string' ? request.question.trim() : ''
          const parts = [
            {
              type: 'text',
              text: question.length > 0 ? question : '请看我框选的这块屏幕内容。',
            },
          ]
          parts.push(buildImageBlock(request.image))

          // Refuse an image before admitting it when the route's model cannot see
          // one, so the failure surfaces here instead of failing the whole turn.
          const selection = ctx.agentDefaultModel.currentSelection()
          const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            respond(res, 409, {
              error: `模型 "${selection.model}" 不接受图片输入；请在 settings.yaml 的 llm-deepseek.models 里为它声明 image 模态，或换一个支持视觉的模型。`,
            })
            return
          }

          // Raw bytes become a durable attachment reference here — the same
          // promotion the Session Remote's own prompt command performs. Skipping
          // this step yields an empty image, because the Agent's message content
          // carries `{ type: 'image', attachment }`, not raw bytes.
          const content = await ctx.attachments.admitPromptContent(parts)
          // The source kind decides whether the human ever sees this message.
          // `message.ts` in ui-chat renders a `user/message` whose
          // `source.kind === 'user'` as an ordinary user bubble, and files every
          // other kind as "non-user context injected into model history" — visible
          // to the model, absent from the transcript. Sending `kind: 'plugin'`
          // therefore made the capture work while looking like the question had
          // never been attached, so this uses the same source shape the browser's
          // own prompt command builds (`commands.ts`, `admit`).
          const message = createUserMessage({
            content,
            source: { kind: 'user', rpcId: randomUUID() },
          })
          if (ctx.agents.get(agent.id) !== agent) {
            respond(res, 409, { error: `会话 ${agent.id} 在提交过程中被释放了。` })
            return
          }
          agent.followup(message)
          ctx.logger?.info?.(
            '[dsh-shot-bridge] admitted a %d-block capture into session %s',
            content.length,
            agent.id,
          )
          respond(res, 200, {
            ok: true,
            message: `已提交给会话 ${agent.id}${request.savedTo ? `（图片：${request.savedTo}）` : ''}`,
            sessionId: agent.id,
            blocks: content.length,
          })
        } catch (error) {
          ctx.logger?.warn?.(
            '[dsh-shot-bridge] admission failed: %s',
            String(error && error.stack ? error.stack : error),
          )
          respond(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      })()
    },
  })

  ctx.effect(() => () => {
    disposeRoute()
    disposeSubmit()
    if (published !== null) {
      try { fs.unlinkSync(published) } catch { /* the file may already be gone */ }
      published = null
    }
  }, 'dsh-shot-bridge: routes and published coordinates')

  // Publish after the listener is up so the port is the real bound one.
  ctx.effect(() => {
    const file = bridgeFile()
    const payload = {
      plugin: name,
      url: `http://127.0.0.1:${ctx.webServer.port}${ROUTE_PATH}`,
      healthUrl: `http://127.0.0.1:${ctx.webServer.port}${HEALTH_PATH}`,
      port: ctx.webServer.port,
      token: secret,
      writtenAt: new Date().toISOString(),
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
      published = file
      ctx.logger?.info?.('[dsh-shot-bridge] listening on %s', payload.url)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-shot-bridge] could not publish %s: %s', file, String(error))
    }
    return () => { /* cleanup handled by the routes effect above */ }
  }, 'dsh-shot-bridge: publish coordinates')

  // Start the ball last: it reads the coordinates this plugin just published.
  launchBall(ctx)
}
