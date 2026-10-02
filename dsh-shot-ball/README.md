# dsh-shot-ball — 桌面悬浮截图球

一个常驻桌面的小圆球，浮在**所有应用之上**。点它 → 框选屏幕任意区域 → 图片存到本地 → 弹出问题框 → 输入问题回车 → 直接提交给 DSH，会话里出模型回复。

流程就是你描述的那个：**先截好图，再说问题，然后直接提交。**

## 为什么必须是独立的桌面程序

浏览器标签页的渲染被限制在自己的窗口里，**原理上不可能浮在别的应用上面**。要"桌面上也能用"，就必须有一个常驻的原生进程。这个程序就是那个进程，用的是 Electron 的置顶窗口和 `alwaysOnTop`。

## 三个部分

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 悬浮球程序 | `G:\ZM\DSH\zmdsh\dsh-shot-ball\` | 常驻桌面、框选抓屏、保存图片、弹出问题框、提交 |
| DSH 桥接插件 | `G:\ZM\DSH\zmdsh\dsh-shot-bridge\` | 把「图片 + 问题」从宿内直接送进会话 |
| 抓屏脚本 | `dsh-shot-ball\scripts\capture.ps1` | 用 `CopyFromScreen` 抓真实屏幕像素 |

## 为什么需要那个桥接插件

这是本方案唯一不那么直白的地方，值得说清。

桌面程序在浏览器外面，**没有任何办法把图片直接投进 DSH 的会话**：

- HTTP/RPC 接口只认浏览器的签名 cookie（由启动 URL 的 token 换发），没有 API key 通道，试探一律 401；
- 伪造草稿附件不行——`DraftAttachmentId` 是 browser-owned 品牌类型，只能由页面内真实投放文件铸出；
- 宿主向页面推送自定义事件也不行——`API_REMOTE_FORWARDED_EVENTS` 是应用级硬编码白名单，插件无权追加。

所以唯一被支持的入口是**从宿主内部提交**。`dsh-shot-bridge` 就干这个：它在 DSH 进程里注册一条本地路由，收到请求后把图片字节经 `ctx.attachments.admitPromptContent()` 提升为持久附件引用，再用 `createUserMessage` + `agent.followup()` 作为一条真正的用户消息送进会话——这正是官方 `SessionCommands.prompt()` 自己走的路径。

**浏览器标签页不需要开着**，这是它比"往浏览器里塞图"那条路好的地方。

## 安装状态（本机已完成）

```powershell
# DSH 侧：桥接插件（已装进 web profile 的 bundles）
dsh plugin --profile web add G:\ZM\DSH\zmdsh\dsh-shot-bridge

# 桌面侧：Electron 依赖（已装进 dsh-shot-ball/node_modules）
cd G:\ZM\DSH\zmdsh\dsh-shot-ball
pnpm install
```

两处都需要**重启 DSH**：桥接插件是宿主插件，重启后它会写出 `%DSH_HOME%\dsh-shot-bridge.json`（端口 + 随机 token）。

## 启动

双击 `start-ball.cmd`，或：

```powershell
cd G:\ZM\DSH\zmdsh\dsh-shot-ball
.\node_modules\electron\dist\electron.exe .
```

球默认出现在主屏右下角。拖动可挪位置（位置会记住），角上的 **×** 可隐藏（下次启动恢复）。

## 用法

1. 点球 → **立刻**出现半透明遮罩（实时桌面透出来，不是冻结画面），拖动鼠标**框选区域**；右下角显示 `宽 × 高`。
2. 松开 → 遮罩瞬间隐藏，只抓你选中的那一小块，保存到 `图片\dsh-shot-ball\shot-<时间戳>.png`。
3. 弹出问题框：左边是缩略图和完整路径，下面是输入框。
4. 输入问题，**Enter 提交**（Shift+Enter 换行，留空则只发图片）。
5. 提交成功后问题框关闭，球回来，会话里出现模型回复。

- **Esc / 右键** 取消框选。
- 问题框里可点「打开图片目录」。

## 全局热键（免点球）

球常驻后，按 **`Ctrl+Alt+S`** 可在**任何应用里**直接开始抓屏：球自己隐藏 → 框选遮罩照常弹出 → 框完依旧弹提问框 → 图文一起送进会话。等价于点一下球，只是不必先找到球、也不必切回 DSH。

- **改键**：`<userData>/preferences.json` 写 `{"captureHotkey": "Control+Shift+Q"}`（Electron accelerator 语法），重启球生效。
- **关掉**：写 `{"captureHotkeyEnabled": false}`。
- **被占用不会静默失败**：组合键已被别的应用注册时，球拿不到它，日志里会留下 `capture hotkey NOT registered: another application owns …`（日志位置见「排查」）。
- **前提**：球必须在运行——它就是这个热键的宿主。要开机自启，把 `start-ball.cmd` 的快捷方式放进 `shell:startup`。

热键与点击**共用同一条流水线**（`beginCapture`），两条入口不会各自漂移。

## 响应速度（实测数据）

两处瓶颈都量过并改掉了。改前「点击→可框选」要 3.5–4.7 秒，改后**瞬时**；「框选→图到手」从 1860 ms 降到 **240 ms（中位）**。

**瓶颈一：点击后立刻冻结所有屏幕。** 原设计在你点球的瞬间抓下每张整屏、PNG 编码、再转 base64 经 IPC 送进遮罩窗口当背景。实测一张 1080×1920 竖屏编码出 2.2 MB，两张屏合计 3 MB→base64 4 MB——这几秒全花在**你还没开始框选**的时候。
现在遮罩是**透明**的，实时桌面直接透出来，一张图都不做；等你框选完，才抓那一个矩形。

**瓶颈二：PowerShell 启动开销。** 抓取本身不慢，慢的是每次拉起 `powershell.exe`——实测空启动就 1130 ms。

| 快门路径 | 900×700 区域耗时（中位） |
| --- | --- |
| **原生小工具**（`scripts/dsh-shot-capture.exe`） | **240 ms** |
| `powershell.exe` + `capture.ps1` | 1860 ms |
| Electron `desktopCapturer` | 约 2400 ms（且把 1080×1920 竖屏压到 608×1080） |

原生小工具由 Windows 自带的 .NET Framework 编译器（`csc.exe`）从 `scripts/Capture.cs` **在球启动时编译一次**（约 2.6 秒，占用的是你还没点击的时间），产物 5.5 KB 缓存在 `scripts\` 下，源码更新会自动重编译。找不到编译器就自动退回 PowerShell，再退到 `desktopCapturer`——三层降级，任何一层可用就不会丢选区。

## 已知边界

- **多显示器**：每个显示器各开一层选择遮罩，可以分别框选；DPI 缩放会先做 per-monitor-v2 声明，避免逻辑像素与物理像素错位（本机 96 DPI，无缩放）。坐标全程使用虚拟桌面空间，不做换算。
- **抓屏双通道**：优先 PowerShell `CopyFromScreen`；失败时回落到 Electron `desktopCapturer`。
- **弹窗位置**：问题框定位在选区右下方，若超出工作区则夹回屏内。
- **本会话未做交互验证**：Electron 窗口需要在真实桌面上点，我无法在这个会话里点击验证。首次运行若球不出现或框选异常，按下面排查。

## 缓存与数据位置（默认全部在 G 盘）

Electron 默认把 `userData`（HTTP 缓存、Code Cache、GPU 缓存、Local Storage、崩溃转储）放到 C 盘的 `%APPDATA%\<app>`。本项目在 G 盘、C 盘只剩约 16 GB，所以两个根目录都被 `app.setPath()` 重定向了——这一步必须在 `app.whenReady()` 之前执行，否则 Chromium 已经解析完路径，调用会被静默忽略。

| 内容 | 位置 | 可用环境变量覆盖 |
| --- | --- | --- |
| Electron 浏览器状态（`userData`） | `G:\ZM\DSH\zmdsh\dsh-shot-ball\.userdata\` | `DSH_SHOT_BALL_HOME` |
| Chromium 缓存 + temp | `G:\ZM\DSH\zmdsh\dsh-shot-ball\.cache\` | `DSH_SHOT_BALL_CACHE` |
| 截图 PNG | `C:\Users\<你>\Pictures\dsh-shot-ball\` | `DSH_SHOT_BALL_CAPTURES` |
| 运行日志 | `G:\ZM\DSH\zmdsh\dsh-shot-ball\.cache\dsh-shot-ball.log` | 随缓存根 |
| Electron 二进制下载缓存 | `G:\ZM\DSH\zmdsh\.electron-cache\` | `ELECTRON_CACHE` |

截图留在 `Pictures` 是有意的——那是你去翻图的地方，不是缓存。想让它也落到 G 盘就设 `DSH_SHOT_BALL_CAPTURES`。

## 排查

| 现象 | 先看这里 |
| --- | --- |
| 球没出现 | `.userdata\preferences.json` 里是否 `"hidden": true`；删掉该文件即恢复 |
| 点击没反应 | 看日志有没有 `renderer: click -> starting capture`；没有就是点击没送达渲染层 |
| 提交报「没找到 DSH 桥接配置」 | 桥接插件没重启生效；确认 `%DSH_HOME%\dsh-shot-bridge.json` 存在 |
| 提交报「不接受图片输入」 | `settings.yaml` 里该模型的 `inputModalities` 缺 `image` |
| 提交报「没有活着的 DSH 会话」 | DSH 里没有活着的会话；先开一个会话 |
| 提交报 HTTP 405 | CORS 预检被拒——桥接插件必须处理 `OPTIONS`（见 `dsh-shot-bridge` 的 README） |
| 框选结果偏位 | 显示器有非 100% 缩放时的 DPI 声明问题，把缩放改回 100% 可确认 |
