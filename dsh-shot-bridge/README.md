# dsh-shot-bridge

DSH 侧的桥接插件：把桌面截图球送来的「图片 + 问题」作为**一条真正的用户消息**注入会话，让模型直接回答。

这是 `dsh-shot-ball`（桌面悬浮球）的配套件，本身没有界面。

## 它解决的具体问题

桌面程序在浏览器外面，把图片投进 DSH 会话有三条看着可行的路，**三条全断**：

| 路 | 断在哪 | 依据 |
| --- | --- | --- |
| HTTP/RPC 接口 | 只认浏览器签名 cookie（启动 URL token 换发），无 API key 通道 | `client-connection/src/browser-auth.ts:289`；实测 401 |
| 伪造草稿附件 | `DraftAttachmentId` 是 browser-owned 品牌类型，只能由页面内真实投放文件铸出 | `ui-conversation/src/client/contract/input.ts:174,192` |
| 宿主推自定义事件到页面 | 转发白名单是应用级硬编码，插件无权追加 | `api/remotes/src/remote-events.ts:16` |

唯一被支持的入口是**从宿主内部提交**。本插件就是这么做的。

## 它怎么做到

```
POST /dsh-shot-bridge/submit
  { question, image: { mediaType, data }, savedTo, sessionId? }
        │
        ▼
  ① 头校验 x-dsh-shot-token（本插件启动时随机生成）
  ② 选目标 Agent：显式 sessionId > 环境变量钉住 > 事件流最新的会话
  ③ 检查该路由模型是否声明了 image 模态（不声明就提前报错，不让整个 turn 失败）
  ④ ctx.attachments.admitPromptContent(parts)
        ← 这一步把原始 base64 字节提升为持久附件引用
          返回 { type:'image', attachment: ImageAttachmentRef }
  ⑤ createUserMessage({ content, source:{kind:'user', rpcId} })
  ⑥ agent.followup(message)   ← 进会话收件箱，模型下一轮就读到
```

## 两个必须避开的坑

### 图片必须经 `admitPromptContent` 提升（第 ④ 步）

**不能**直接把 `{type:'image', mediaType, data}` 放进消息内容——Agent 的消息内容里图片是 `{type:'image', attachment: ImageAttachmentRef}`，`ctx.llm` 适配器读的也是 `.attachment`（见 `llm-deepseek/src/adapter.ts:215`）。跳过提升这一步会得到一张空图。

### 来源必须是 `kind:'user'`，否则消息不显示（第 ⑤ 步）

`ui-chat` 的 `conversation-nodes/message.ts:44-65` 用来源分流一条 `user/message`：

- `source.kind === 'user'` → 渲染成**普通用户气泡**
- 其他任何 kind → 归为 `context` 节点，注释原话是 *"Non-user context injected into model history"*

**它只进模型上下文，不出现在对话里。** 也就是说用 `kind:'plugin'` 会让截图提问看起来「问题根本没带上」——图能看、模型能答，但**人看不到自己发过什么**，对话记录里是断的。

修复前会话里的对比（同一台机器、同一个会话）：

```
22:20:11  {"kind":"plugin","plugin":"dsh-shot-bridge"}  blocks=text+image   ← 不显示
21:38:31  {"kind":"user","rpcId":"…","clientTimeZone":"…"}  blocks=image+text  ← 显示
```

所以这里复刻浏览器自己的形状：`{ kind:'user', rpcId: randomUUID() }`。

这条路径与官方 `SessionCommands.prompt()` 完全一致（`api/session-controller/src/commands.ts:302-375`，它同样走 `admitPromptContent` → `createUserMessage` → `agent.followup`）。

## 依赖的服务

`inject: ['webServer', 'agents', 'attachments', 'llm']`

- `webServer` — 挂路由（**不新开端口**，复用 DSH 已监听的 3080）
- `agents` — `ctx.agents.get(sessionId)` / `.list()`
- `attachments` — 图片字节 → 持久引用
- `llm` — `resolveModelInfo` 查模型是否支持图片

## 坐标文件

激活时写入 `%DSH_HOME%\dsh-shot-bridge.json`（权限 0600）：

```json
{
  "plugin": "dsh-shot-bridge",
  "url": "http://127.0.0.1:3080/dsh-shot-bridge/submit",
  "healthUrl": "http://127.0.0.1:3080/dsh-shot-bridge/health",
  "port": 3080,
  "token": "<每次启动新生成>",
  "writtenAt": "..."
}
```

token 每次 DSH 启动重新生成，所以**重启 DSH 后桌面球会自动读到新 token**（它在每次提交前重新读这个文件）。

## 随 DSH 自启桌面球

本插件挂载时会把桌面球一起拉起来（`launchBall`），所以**不需要系统开机自启**：DSH 起来，球就在；DSH 用哪个实例，球就提交回哪个实例。

- 启动时**显式传 `DSH_HOME`**（本进程自己的 home）。这一步是关键：网页版 home 写的是 `3080`、桌面版 home 写的是 `19387`，token 也不同——不传的话球会按 `start-ball.cmd` 的默认值提交到另一个实例去。
- 球自带单实例锁，**重复启动无害**：已经在跑的球不会被拉出第二个。
- 球是 `detached` 启动的，所以 **DSH 退出后球会留着**（不会自动关）。要它跟着 DSH 一起退，需要额外做进程树清理。
- 关掉自启：设环境变量 `DSH_SHOT_BALL_AUTOSTART=0`。
- 换球的位置：设 `DSH_SHOT_BALL_DIR`（默认 `G:\ZM\DSH\zmdsh\dsh-shot-ball`）。
- 找不到 Electron 时不会静默：日志留 `ball autostart skipped: … is missing`。

## CORS 与 token 传递（踩过的坑）

桌面球的渲染层从 `file://` origin 发请求，所以对这条 loopback 路由来说是**跨源**请求。最初把 token 放在自定义头 `x-dsh-shot-token` 里，于是浏览器先发 `OPTIONS` 预检——而 handler 对非 POST 一律回 405，**预检被拒，POST 根本没发出去**，球那边只看到「HTTP 405」。

现在两处都修了，形成双保险：

1. **handler 处理 `OPTIONS`**，返回 204 加 `access-control-allow-origin: *`、`access-control-allow-methods`、`access-control-allow-headers`、`access-control-max-age`；所有响应也都带上这些头。
2. **token 改走查询串** `?token=...`，与 `content-type: application/json` 一样都在 CORS 安全名单内，**完全不触发预检**。头方式仍然保留，方便 curl 之类的非浏览器调用方。

安全边界没变：路由只存在于 loopback 绑定的 web surface 上，token 依旧校验，所以 `allow-origin: *` 并没有把可访问面扩大到本机之外。**但这也意味着本机上的任意网页都能尝试打这条路由**——真正的防线是那个每次启动重新生成的随机 token，以及不要把这个 DSH 暴露到网络。

## 另一个端点

`GET /dsh-shot-bridge/health` 返回插件状态和当前活跃会话列表，便于排查：

```powershell
$cfg = Get-Content "$env:DSH_HOME\dsh-shot-bridge.json" -Raw | ConvertFrom-Json
Invoke-RestMethod $cfg.healthUrl
```

## 限制

- **只认第一个活跃会话**：未指定 `sessionId` 时取 `ctx.agents.list()` 里状态为 `running`/`idle` 的第一项。要多会话精确投放，需要桌面球把 `sessionId` 传进来（当前未做界面选择）。
- **单图上限 12 MiB**（解码后字节数），超出直接拒绝。
- **`inject` 是静态的**：改动 `inject` 列表必须**冷启动 DSH**。文件热重载只换代码体、不重新求值 `inject`，会出现「函数体是新的、注入服务是旧的」这种自相矛盾的现象。
- 与 `dsh-shot-ask`（浏览器内的框选提问）是两条独立路线，互不依赖，可同时装。
