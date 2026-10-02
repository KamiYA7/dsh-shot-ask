# dsh-shot-ask

框选屏幕任意区域 → 输入问题 → 回车，**截图与问题一次动作送进当前会话**。

这是给 DSH Web GUI 用的本地临时工具插件，是**桌面截图球那条线在浏览器里的对应入口**：浏览器标签页浮不到别的应用上面，所以需要随手在网页里框选提问时用这个。

## 它做了什么

两处入口，共用同一条截图→提问流水线：

1. **可拖动悬浮球**（默认开启）：浮在页面任意位置，点击即框选截图；拖动可改位置（位置记在 `localStorage`）；角上的 **×** 可直接关掉。
2. **设置 → 通用 → 「悬浮截图提问」**（`settings.general.item`）：悬浮球开关、截图目录（可复制）、桥接自检按钮。

流程：触发 → **宿主原生抓屏**（浏览器里退回 `getDisplayMedia`）→ 全屏遮罩（桌面壳下把抓到的画面铺成背景）→ **拖动鼠标框选区域** → 松开冻结选区预览 + 弹出问题面板（含「这是什么？」「解释一下这段内容」等快捷问法）→ 输入问题按 Enter（或点「发送提问」）→ 图片经 DSH 官方附件 intake 进输入框，问题写入草稿，随后自动按下发送。

## 宿主半边

除了挂载客户端 bundle，`lib/index.js` 还提供两条**只读**路由，供设置行读取网页拿不到的信息：

| 路由 | 返回 |
| --- | --- |
| `GET /dsh-shot-ask/info` | 截图目录、PNG 数量、桥接配置是否存在 |
| `GET /dsh-shot-ask/bridge-test` | 实时探测桥接 health 与活跃会话数 |
| `GET /dsh-shot-ask/capture.png` | 原生抓取光标所在屏并返回 PNG（桌面壳里 `getDisplayMedia` 被禁，悬浮球走这条；非 Windows 返回 501，客户端退回浏览器选择器） |

两条都不接受输入、不做鉴权（一条报本地目录、一条问桥接自检），只存在于 loopback 绑定的 web surface 上。

悬浮球的显隐存在浏览器 `localStorage`（键 `dsh-shot-ask:preferences:v1`），因此：
- 开机默认**显示**；
- 改过一次之后，刷新/重启都记住你的选择，不会自己弹回来。
- 想彻底重置：浏览器控制台执行 `localStorage.removeItem('dsh-shot-ask:preferences:v1')` 后刷新。

悬浮球元素带 `data-dsh-shot-ask-ball` 属性，方便在 DevTools 里定位。


## 依赖与前置条件

| 项 | 要求 |
| --- | --- |
| 宿主 | DSH 0.1.5-rc.2（本机实测版本），走 `dsh web` |
| 浏览器 | 支持 `getDisplayMedia`；每次截图需在系统选择器里选一个屏幕 |
| 模型 | 当前路由必须声明 `image` 模态，否则宿主在发送前就拒收图片 |

模型这一步是关键。`$DSH_HOME/settings.yaml` 里 `llm-deepseek.models` 必须声明：

```yaml
llm-deepseek:
  models:
    - id: deepseek-flash
      inputModalities: [text, image]
      imagePixelBudget: 4194304   # 可选：放宽到 2048×2048 像素
      imageMaxBytes: 6291456      # 可选：单图 6 MiB 上限
```

`deepseek-flash` 在 `llm-deepseek` 插件自带目录里**默认就是** `[text, image]`；一旦在 settings 里写了 `inputModalities: []`，schema 会判它非法（`expected array length >= 1`），识图能力随之丢失。这是本插件曾经的真实翻车点，别再写成空数组。

## 安装（本机已装）

```powershell
# 装进 web profile，并自动注册到 dsh.profile.bundles
dsh plugin --profile web add G:\ZM\DSH\zmdsh\dsh-shot-ask
```

因为走的是 `link:`，改完 `lib/client.js` 不需要重装；但**插件变更需要重启 `dsh web`** 才生效（客户端 bundle 在启动时扫描进 `window.__DSH_BOOT__`）。

## 卸载

```powershell
dsh plugin --profile web remove dsh-shot-ask
```

纯外挂：不改 DSH 本体、不写会话事件、不注册服务或工具；host 半边是空壳，只为让 `dsh.client` 被扫描到。

## 边界与已知限制

- **悬浮球挂在侧边栏的 root 槽位上**：注册点是 `sidebar.footer.action`（这是插件能拿到的、随应用外壳常驻的 root 级槽位），但球本身是 `position: fixed` 并被 portal 到 `document.body`，所以视觉上浮在整个视口上、不受侧边栏布局限制。代价是：**侧边栏整体不渲染时（如极窄屏折叠），悬浮球会一起消失**——此时改用桌面截图球（`dsh-shot-ball`）。
- **抓屏通道有两种**：桌面壳（DSH Desktop）在 `configureSession` 里用 `setDisplayMediaRequestHandler(callback => callback({}))` 空授权、并把三类权限处理器全部设为 `false`，因此桌面窗口里的 `getDisplayMedia` 必然拿不到画面。悬浮球改为请求宿主路由 `/dsh-shot-ask/capture.png`，由宿主用 PowerShell `CopyFromScreen` 原生抓取**光标所在那块屏**（免选屏）；纯浏览器里没有这条路由，自动退回 `getDisplayMedia` 的系统选择器。选区按 `naturalWidth / innerWidth` 等比换算，多显示器下按被抓那块屏等比映射。
- **发送按钮靠 DOM 定位**：通过 `aria-label`（send / 发送 / 提交）找输入框主按钮。DSH 改版换文案时可能失效——届时图片和问题已安全躺在输入框里，手动回车即可。
- **投递机制是合成 drop**：与手动拖图进输入框走同一条官方通道（`dataTransfer.types` 含 `Files`），因此受官方的大小/数量/类型上限约束。
- 选区坐标按 `videoWidth / innerWidth` 换算，多显示器缩放下按所选屏幕等比映射。
