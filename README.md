# dsh-shot-ask · 抓屏即提问

> **给 [DSH / DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的截图提问套件。**
> 在**任何应用**里按一个热键（或在 DSH 页面里点一下悬浮球）→ **框选屏幕任意区域** → 就地写下问题 → **图片和问题一起进当前会话**。
> 不用存文件、不用切窗口、不用复制粘贴。

[English](#english) · [安装](#安装) · [用法](#用法) · [架构](#架构为什么是三个包) · [排查](#故障排查)

---

## 它解决什么问题

看到一段报错、一张图表、一个界面不对——想直接问模型，但标准流程是：

```
截图 → 存文件 → 切到 DSH → 找输入框 → 拖图进去 → 打字 → 回车
```

七步。这个套件把它压成**两步**：

```
按热键 → 框选 + 打字（在同一个浮层里完成）
```

而且抓屏**免选屏授权**：不弹系统选择器、不需要录屏权限，框完就把那一小块送进会话。

### 两条入口，覆盖两种姿势

| 姿势 | 入口 | 适合 |
| --- | --- | --- |
| 你正在别的应用里（浏览器、IDE、播放器…） | **全局热键 `Ctrl+Alt+S`** | 桌面上那个常驻小球。抓到的是你按热键那一刻的屏幕 |
| 你就在 DSH 窗口里 | **页面悬浮球** | 可拖动、位置记在 localStorage、角上有 × 可关 |

两条入口最终走**同一条流水线**，行为一致。

---

## 三个组成部分

| 包 | 形态 | 它做什么 |
| --- | --- | --- |
| [`dsh-shot-ball`](dsh-shot-ball/README.md) | 独立 Electron 程序 | 常驻桌面、**置顶**。承载全局热键、框选遮罩、提问框；把「图片 + 问题」POST 给桥接 |
| [`dsh-shot-bridge`](dsh-shot-bridge/README.md) | DSH **宿主插件** | 回环 HTTP 路由 `/dsh-shot-bridge/{submit,health}`（token 鉴权）；经官方 `admitPromptContent` 把图提升为**持久附件**并注入会话；并在 DSH 启动时把球拉起来 |
| [`dsh-shot-ask`](dsh-shot-ask/README.md) | DSH **客户端插件 + 宿主路由** | 页面悬浮球 + 设置行；宿主侧原生抓屏路由 `/dsh-shot-ask/capture.png` |

**为什么不是一个大包？** 因为三者的宿主不同：球运行在你的桌面上（Electron），桥接运行在 DSH 进程里（Cordis 插件），悬浮球运行在 DSH 页面里（浏览器）。三边各有自己的生命周期与权限，混在一起反而装不上。

---

## 架构：为什么是三个包

### ① 热键必须由一个置顶窗口承载

热键是在**别的应用里**按下的，那一刻 DSH 窗口在后台。框选遮罩如果画在 DSH 页面里，**你根本看不见它**。所以「热键 + 遮罩」只能落在常驻置顶的独立程序上——也就是那个 Electron 小球。

### ② 图必须经宿主的 `admitPromptContent` 进会话

桌面程序在 DSH 外面。把图片投进会话的三条"看起来可行"的路全是断的：HTTP 接口只认浏览器签名 cookie、草稿附件 id 是 browser-owned、宿主转发事件白名单硬编码。**唯一被支持的入口是从宿主内部提交**——所以必须有一个跑在 DSH 进程里的宿主插件（`dsh-shot-bridge`）来接收并 `admitPromptContent`。

图片以 base64 走回环 HTTP，**不经过任何中间文件**；落盘只是顺带存档。

### ③ 桌面壳关死了 `getDisplayMedia`

DSH Desktop 在会话初始化时这样写：

```js
setPermissionRequestHandler((_c, _p, cb) => cb(false))   // 所有权限一律拒绝
setPermissionCheckHandler(() => false)
setDevicePermissionHandler(() => false)
setDisplayMediaRequestHandler((_req, cb) => cb({}))       // 空授权 = 不给任何源
```

所以**桌面窗口里的 `getDisplayMedia()` 永远拿不到画面**。页面悬浮球因此改为请求宿主路由 `/dsh-shot-ask/capture.png`——由宿主用 PowerShell `CopyFromScreen` **原生抓取光标所在那块屏**（多显示器也对），免授权、免选屏。纯浏览器里没有这条路由，会自动退回 `getDisplayMedia` 的系统选择器。

---

## 安装

**前置**：Windows + [DSH](https://github.com/deepseek-ai/deepseek-harness)。把三个包放在一个**固定目录**（以后不要挪）。

```powershell
# ① 两个 DSH 插件装进你在用的 profile（web / desktop）
dsh plugin --profile desktop add <路径>\dsh-shot-ask
dsh plugin --profile desktop add <路径>\dsh-shot-bridge

# ② 桌面球的依赖
cd <路径>\dsh-shot-ball
pnpm install

# ③ 重启 DSH
```

> `desktop` profile 由官方 Desktop 应用独占，只有它自带的 CLI 能管理（普通 CLI 会报 `profile "desktop" is managed exclusively by the Electron application`）。用 web 版就把 `--profile desktop` 换成 `--profile web`。
>
> `.npmrc` 不入库（它按机器写死了 pnpm 的 `store-dir`）。需要时在 `dsh-shot-ball/` 里自行建一个，常见两条：
>
> ```ini
> node-linker=hoisted
> confirmModulesPurge=false
> ```

装好之后 **DSH 启动时会自动拉起桌面球**，不需要开机自启项。不想自动拉起就设 `DSH_SHOT_BALL_AUTOSTART=0`。

---

## 用法

### 全局热键（推荐）

1. 在任意应用里按 **`Ctrl+Alt+S`**；
2. 所有屏幕出现半透明遮罩，**拖动鼠标框选**（Esc / 右键取消）；
3. 松开 → 弹出提问框（左边缩略图，下面输入框）；
4. 输入问题，**Enter 提交**（Shift+Enter 换行；留空就只发图片）；
5. 图片 + 问题出现在 DSH 会话里，模型开始回答。

### 页面悬浮球

在 DSH 窗口里点右下角的球，之后流程完全一样。球可拖动、位置记住、角上 × 关闭；设置行在 **设置 → 通用 → 「悬浮截图提问」**（可复制截图目录、可一键桥接自检）。

---

## 配置

| 名称 | 作用 |
| --- | --- |
| `DSH_HOME` | **决定球提交回哪个 DSH 实例**。网页版与桌面版各写一份 `dsh-shot-bridge.json`（端口 + token 都不同），球按这个变量找坐标 |
| `DSH_SHOT_BALL_AUTOSTART=0` | 不让 DSH 拉起球 |
| `DSH_SHOT_BALL_DIR` | 球所在目录（默认 `G:\ZM\DSH\zmdsh\dsh-shot-ball`） |
| `DSH_SHOT_BALL_CAPTURES` | 截图归档目录（默认 `图片\dsh-shot-ball`） |
| `dsh-shot-ball/.userdata/preferences.json` | `{"captureHotkey":"Control+Shift+Q"}` 改键；`{"captureHotkeyEnabled":false}` 关掉热键 |

---

## 故障排查

| 症状 | 原因与处理 |
| --- | --- |
| 页面悬浮球点了没画面 | 桌面壳禁用了 `getDisplayMedia`；确认宿主路由在位（`GET /dsh-shot-ask/capture.png` 返回 `image/png`） |
| 图进了**另一个** DSH 实例 | 球的 `DSH_HOME` 指错了（网页版 3080 / 桌面版 19387，坐标文件各一份） |
| 热键没反应 | 球没在跑，或组合键被别的应用占用——球的日志里会写 `capture hotkey NOT registered: another application owns …` |
| 提交返回 401 | token 失效。token 每次 DSH 启动重新生成，球在每次提交前重读坐标文件；重启 DSH 即可 |
| 图片被拒收 | 当前路由的模型必须声明 `image` 模态 |
| 发送没自动按下 | 发送按钮靠 `aria-label` 定位，DSH 改版可能改文案；此时图片已安全躺在输入框里，手动回车即可 |

日志位置：`dsh-shot-ball/.cache/dsh-shot-ball.log`。

---

## 已知边界

- **热键宿主是球**：球不在跑，热键就不存在（DSH 启动会自动拉起它）。
- **球是 detached 启动的**：DSH 退出后球会留着，此时桥接已消失，提交会失败——关掉球即可。
- **默认目标是"最近活跃的会话"**：桥接会在活跃会话里挑一个；想固定目标需要在提交里带 `session` 参数。
- **选区坐标按比例换算**：`naturalWidth / innerWidth`，多显示器缩放下按被抓那块屏等比映射。
- **纯浏览器路径仍需选屏**：`getDisplayMedia` 必须由系统选择器授权；桌面壳下走原生抓屏，无此限制。

---

## 许可

[MIT](LICENSE) © 2026 KamiYA7

---

<a id="english"></a>

## English

**A screenshot-to-question kit for [DSH / DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Press a global hotkey (**`Ctrl+Alt+S`**) in any application, drag a rectangle over anything on screen, type your question in the same overlay, and the cropped image plus your question land in the current DSH session — no files on disk, no window switching, no screen-picker permission prompt.

Three packages, because each half runs in a different host:

- **`dsh-shot-ball`** — a resident, always-on-top Electron program. It owns the global hotkey, the selection overlay and the question box, and POSTs the capture to the bridge.
- **`dsh-shot-bridge`** — a DSH **host plugin**. It exposes a token-guarded loopback route, promotes the image through the official `admitPromptContent` path (the only supported way into a session from outside the browser), and starts the ball together with DSH.
- **`dsh-shot-ask`** — a DSH **client plugin plus host routes**. The in-page floating ball, plus a native capture route (`/dsh-shot-ask/capture.png`) because the Desktop shell answers `getDisplayMedia` with an empty grant and denies every permission request.

```powershell
dsh plugin --profile <web|desktop> add <path>\dsh-shot-ask
dsh plugin --profile <web|desktop> add <path>\dsh-shot-bridge
cd <path>\dsh-shot-ball; pnpm install
# restart DSH — the ball starts with it
```

Requires Windows. Licensed under MIT.
