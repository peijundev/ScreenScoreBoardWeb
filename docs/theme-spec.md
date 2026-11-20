# 计分板主题规范（v1）

主题是**一组视觉设置的 JSON 快照**，可在项目之间、设备之间导入导出。主题不包含人员/团队数据，也不包含上传的图片、音频与布局坐标。

## 1. 文件格式

```json
{
  "format": "screenscoreboard.theme",
  "version": 1,
  "name": "示例主题",
  "author": "你的名字",
  "description": "一句话说明",
  "baseStyle": "lecture",
  "settings": {
    "theme": "dark",
    "accent": "#e8a33d",
    "cardStyle": "glass",
    "cardRadius": 12
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `format` | 是 | 固定为 `screenscoreboard.theme` |
| `version` | 是 | 当前为 `1` |
| `name` | 否 | 主题名（最多 60 字） |
| `author` | 否 | 作者（最多 60 字） |
| `description` | 否 | 说明（最多 300 字） |
| `baseStyle` | 否 | 基础风格，必须属于下方允许列表；省略则不改动当前风格 |
| `settings` | 是 | 设置键值对；**只覆盖提供的键**，未提供的保持项目原值 |

## 2. 基础风格（baseStyle）

```
lecture | ppt | seewo | kde | guofeng | ink | trueage | modern | neon | poster | custom
```

`custom` 表示“自由配置”，不套用内置皮肤，完全由主题设置决定外观。

## 3. 允许的设置项

导入时服务端会逐项校验：**出现白名单之外的键会整体拒绝**；值不合法也会拒绝（不会部分生效）。

### 基调与颜色

| 键 | 取值 |
|---|---|
| `theme` | `dark` / `light` |
| `accent` | `#rrggbb` |
| `textColor` | `#rrggbb` 或 `""`（跟随主题） |
| `positiveColor` / `negativeColor` | `#rrggbb` |
| `rankColor` | `#rrggbb` 或 `""` |
| `cardBorderColor` / `teamAccentColor` | `#rrggbb` 或 `""` |

### 标题

`titleAlign`（`auto`/`center`/`left`/`right`）、`titleDecor`（`auto`/`plain`）、
`titleFont`（`auto`/`system`/`serif`/`kai`/`custom`）、`titleFontCustom`（≤60 字）、
`titleSize`（0–120，0=自动）、`titleColor`（`#rrggbb` 或 `""`）、`showTitleRule`（布尔）

### 字体

- 正文字体：`fontFamily`（`system`/`serif`/`kai`/`custom`）、`fontFamilyCustom`、`fontScale`（0.7–1.5）
- 分数：`scoreFont`（`auto`/`system`/`serif`/`kai`/`custom`）、`scoreFontCustom`
- 时钟：`clockFont`、`clockFontCustom`、`clockFontSize`（0–200）
- 倒计时：`countdownFont`、`countdownFontCustom`、`countdownFontSize`（0–300）
- 排行榜：`leaderboardFont`、`leaderboardFontCustom`
- 跑马灯：`marqueeFont`、`marqueeFontCustom`
- 欢迎幕布：`welcomeFont`、`welcomeFontCustom`、`welcomeFontSize`（0–300）
- 简介：`bioFont`、`bioFontCustom`、`bioSize`（0–64）、`bioColor`、`bioOpacity`（0.2–1）、`bioItalic`

其中“部件字体”的取值均为 `auto` / `system` / `serif` / `kai` / `custom`；`auto` 表示跟随内置默认或主题。

### 卡片与间距

`cardStyle`（`solid`/`glass`/`neumorph`/`neon`/`gradient`/`paper`）、
`cardBgMode`（`auto`/`custom`/`translucent`/`acrylic`）、`cardBg`、`cardOpacity`（0.15–1）、
`cardAcrylicBlur`（0–40）、`cardRadius`（0–32）、`glassBlur`（0–40）、`glassOpacity`（0.15–0.95）、
`cardBorderWidth`（0–6）、`cardShadow`（`auto`/`none`/`soft`/`medium`/`strong`）、
`teamAccentWidth`（0–12）、`showTeamAccent`、`avatarBorderWidth`（0–6）、`avatarShape`（`circle`/`square`）、
`boardMaxWidth`（900–2600）、`cardGap`（0–60）、`cardPad`（0–60）、`memberScale`（0.6–2）、
`rankSize`（10–40）、`scoreBarHeight`（0–16）

### 背景（不含图片本身）

`bgColor`（`#rrggbb` 或 `""`）、`bgScrimEnabled`、`scrimOpacity`（0–1）、
`bgImageBlur`、`bgImageBlurAmount`（0–40）

### 倒计时窗口

`countdownTheme`（`classic`/`ink`/`video`）、`countdownShape`（`circle`/`square`/`rounded`/`rounded-rect`/`rect`）、
`countdownSize`（200–900）、`countdownHeight`（0–900）、`countdownRadius`（0–120）、
`countdownBgMode`（`theme`/`custom`/`translucent`/`acrylic`）、`countdownBg`、`countdownOpacity`（0.2–1）、
`countdownBlur`（0–40）、`countdownTextColor`

### 排行榜 / 跑马灯 / 欢迎幕布

`leaderboardScale`（0.8–1.6）、`marqueeFontSize`（0–120）、`marqueeColor`、`marqueeBgColor`、`welcomeBgColor`

## 4. 明确不包含的内容

- 人员、团队、分数、排序方式、布局坐标、自由布局开关
- 功能开关（时钟/倒计时/排行榜等是否启用）
- 上传资产：`bgImage`、`cardImage`、`welcomeImage`、`customSound`、`bgmFile`
- 项目名、标题文字（`title`）、列数（`columns`）

需要这些内容时请使用「导出项目」而不是「导出主题」。

## 5. 制作流程

1. 打开管理端 → **主题编辑器**
2. 选择基础风格，调整颜色、字体、卡片、背景、倒计时等（修改实时生效）
3. 填写主题名/作者/说明
4. 点击 **导出主题**，得到 `<主题名>.theme.json`
5. 在目标项目/设备打开 **主题编辑器** → **导入主题**，选择该文件

导入会立即应用到当前项目，并通过 WebSocket 同步到显示端。

## 6. 校验与兼容

- 主题文件只接受 `format = screenscoreboard.theme`、`version = 1`
- 未知键、非法值、非法基础风格会导致整份主题被拒绝，当前设置不变
- 主题是“覆盖式”的：未提供的键保持项目原值；如需完全统一，可先重置项目再导入
- 内置主题「真·古风」（`trueage`）已恢复；使用该风格的旧项目与旧导出文件会原样保留，不再回落到 `lecture`

## 7. 示例

```json
{
  "format": "screenscoreboard.theme",
  "version": 1,
  "name": "青竹夜",
  "author": "peijundev",
  "description": "深色底 + 竹青强调色 + 半透明卡片",
  "baseStyle": "custom",
  "settings": {
    "theme": "dark",
    "accent": "#6f9a62",
    "textColor": "",
    "cardStyle": "glass",
    "cardBgMode": "acrylic",
    "cardBg": "#0f1a13",
    "cardOpacity": 0.55,
    "cardAcrylicBlur": 16,
    "cardRadius": 14,
    "fontFamily": "serif",
    "titleFont": "kai",
    "titleSize": 64,
    "bioFont": "kai",
    "bioSize": 18,
    "bioColor": "#9bbf8f",
    "bioItalic": true
  }
}
```
