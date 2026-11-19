# 主题 v2 与主题工作室

主题 v2 是「描述文件 + 矢量场景 + 声明式控件 + 现有视觉设置」的组合。主题库保存在服务端，项目通过 `themeId + themeRevision` 引用已应用主题；项目草稿单独保存，不进入热状态广播和长期备份。

## 文件格式

同一份主题可以用 JSON 或 TOML 表达。主题工作室的「TOML / JSON」页自动识别输入格式，导入 v1 `.theme.json` 时会升级为 v2。

```toml
format = "screenscoreboard.theme"
version = 2

[meta]
name = "示例主题"
author = ""
description = ""
baseStyle = "custom"

[canvas]
width = 1920
height = 1080

[canvas.background]
type = "color"
color = "#101820"

[[layers]]
name = "装饰"

[[layers.nodes]]
type = "rect"
x = 80
y = 80
w = 420
h = 220
fill = "#e8a33d"
radius = 20

[[widgets]]
type = "title"
surface = "canvas"
x = 100
y = 40
w = 900
h = 100
visible = true

[widgets.props]
fontSize = 64
color = "#ffffff"
align = "left"

[widgets.bind]
value = "project.title"

[[widgets]]
type = "score"
surface = "card"
slot = "score"
visible = true

[widgets.props]
fontSize = 56
color = "#ff00aa"

[widgets.bind]
value = "self.score"

[settings]
accent = "#e8a33d"
cardRadius = 16
```

`settings` 只能出现现有主题白名单中的视觉设置项（与服务端 `THEME_SETTING_KEYS` 一致），值由服务端校验。

## 矢量场景

- `canvas`：设计画布宽高与背景。
- `layers`：绘制顺序，支持 `visible/locked/opacity/blendMode/x/y/rotation/scaleX/scaleY`。
- `nodes`：`rect | ellipse | line | path | text | image`。
- `rect` 使用 `radius` 圆角；`ellipse` 由 `w/h` 决定椭圆，不读取圆角。
- `line` 从 `(x, y)` 画到 `(x + w, y + h)`；为表达任意方向，线段的 `w/h` 允许为负，其余图形宽高必须非负。
- 矢量子编辑器支持直接拖动绘制形状（Shift 约束为正方形/正圆/45° 线段）；不拖动而单击时按默认尺寸创建。
- `path`：`points` 数组，每点包含 `x/y/in/out/mode`；`in/out` 是相对锚点的贝塞尔控制柄，`closed` 控制闭合。
- 图片只允许 `avatars/*`、`/media/*`、内联 `data:image/*`；禁止外链和脚本。

## 控件 SDK

控件是声明式配置，不执行任意 HTML/CSS/JS。

字段：

- `type`：文本、标题、分数、名次、头像、图片、姓名、简介、团队名、成员数、进度条、时钟、倒计时。
- `surface`：`canvas | card | teamCard | memberChip`。
- `slot`：卡片挂载点 `rank/avatar/name/bio/score/bar/teamName/teamTotal/extra`。
- `x/y/w/h`：仅 canvas surface 使用。
- `props`：文本、字号、颜色、对齐、背景等。
- `bind.value`：`project.title`、`self.name`、`self.score`、`self.avatar`、`team.name`、`team.total`、`rank`、`memberCount`、`countdown.remaining` 等。

卡片控件替换对应的默认 slot；没有匹配控件时渲染原有卡片结构，保证旧项目零行为变化。

## 主题库与项目草稿

- 主题库：服务端持久化，支持新建/复制/重命名/删除/导入/导出。
- 项目草稿：每个项目一份，`draftSave` / `draftDelete`；预览通过同源 postMessage 推送，不写服务端。
- 发布并应用：校验草稿 → 写主题库 → 更新项目 `themeId/themeRevision` → 应用 `settings` 子集 → 显示端按 revision 拉取主题 spec。
- 删除主题会自动解绑引用项目；项目已应用的 settings 保留作为降级外观。

## 限额与安全

- 单主题 ≤ 512KB；主题库 ≤ 200 个 / 5MB；layers ≤ 50；单层节点 ≤ 500；总节点 ≤ 2000；widgets ≤ 100；path points ≤ 500；嵌套深度 ≤ 12。
- 服务端白名单重建，未知字段丢弃；非法值整体拒绝。
- 显示端只通过 React 元素渲染 SVG/控件，不使用 `dangerouslySetInnerHTML`；脚本只返回受限绘制指令。
- 主题库/草稿不进入 WS 热广播；显示端按需读取，避免记分广播携带大对象。

## 沙箱脚本

### 启用链路

1. 项目设置 →「特效」→「主题脚本（沙箱）」打开 `themeScriptEnabled`（默认关闭）。
2. 主题工作室 →「脚本」填写源码，勾选「启用主题脚本」，设置入口函数并保存。
3. 显示端只有在 **项目开关开启 + 主题 `script.enabled=true` + 源码非空** 三者同时满足时才运行脚本。

主题文件里的 settings 不能开启 `themeScriptEnabled`；它属于项目安全开关，不进入 `THEME_SETTING_KEYS`。

### 脚本契约

```js
function drawTheme(ctx) {
  return [
    { op: 'rect', x: 40, y: 40, w: 320, h: 96, rx: 18, fill: '#000000', opacity: 0.35 },
    { op: 'text', x: 60, y: 88, text: '第一名 ' + ctx.people[0].name, size: 28, color: '#ffffff', align: 'left' },
  ];
}
```

- `source` ≤ 32KB；`entry` 必须是合法标识符，默认 `drawTheme`；脚本必须同步返回数组。
- `ctx`：`t`、`frame`、`width`、`height`、`projectName`、`title`、`accent`、`theme`、`displayStyle`、`people`（id/name/score/teamId/rank，最多 300）、`teams`（id/name/total/memberCount，最多 100）、`maxScore`、`totalScore`、`countdown`。
- 指令：`rect`、`ellipse`、`line`、`text`、`path`、`polygon`；数量 ≤ 200，路径 ≤ 4000 字符，文本 ≤ 200 字符。
- 颜色仅 `#rgb` / `#rrggbb` / `none` / `transparent`；坐标、尺寸、透明度、字号、线宽均会收敛到安全范围。
- 刷新率 `themeScriptFps` 1–30（默认 8，是**上限**；慢脚本会被合并到下一帧）；单帧超时 `themeScriptTimeoutMs` 20–500ms（默认 120）。

### 隔离边界

- `sandbox="allow-scripts"` 且不带 `allow-same-origin`：iframe 为不透明源，无法读取父页面 DOM。
- iframe CSP：`default-src 'none'`，仅允许内联脚本、eval 和 blob Worker；禁止网络、图片、样式、表单与导航。
- 用户源码在专用 Worker 中执行；iframe 记录超时并终止 Worker，父页面在失败后短暂暂停重试。
- Worker 预置移除 `Worker`/`importScripts`/`fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`indexedDB`/`caches`/`BroadcastChannel`；CSP 再叠加一层网络封锁。
- iframe 与父页面各做一次指令数量/体积/字段校验；只把白名单指令交给 React SVG 渲染。
- 非法指令逐条丢弃；超限、超时、Worker 异常或非数组输出整帧丢弃。
- iframe 为不透明源，`postMessage` 的 `targetOrigin` 只能为 `'*'`；安全性依赖 `event.source` 校验、沙箱隔离与父侧指令白名单。
- 脚本可以读取 `ctx` 中的项目数据（姓名、分数、团队、标题等），但无法联网外发；仍然只应导入可信来源的主题文件。
- Worker 执行路径与指令清洗由 `scripts/theme-script.test.mjs` 覆盖；`npm run test:theme` 会同时跑 schema 与脚本测试。
