# 计分板

显示端 + 管理端的实时计分板网页，Node 原生 http + WebSocket技术栈，不用构建。支持多项目（每个项目一个独立积分榜）和可切换的存储后端（JSON / SQLite / PostgreSQL / MySQL）。

## 启动

```bash
npm install
npm start
```

- 显示端（大屏）：http://localhost:3000/display
- 管理端（控制台）：http://localhost:3000/admin

局域网内其他设备用本机 IP 访问同一地址即可。端口可用 `PORT=8080 npm start` 修改。

Node 版本要求 20+，项目用 `.nvmrc` 固定为 24。如果切换了 Node 大版本，使用 SQLite 后端前需要重新编译原生模块：

```bash
npm rebuild better-sqlite3
```

## 多项目

管理端顶部可以新建 / 重命名 / 删除项目，每个项目拥有独立的人员、团队、分数和全部外观设置。切换项目后，管理端预览和显示端链接会自动带上 `?project=<项目id>`：

- 管理端：`/admin?project=<id>`
- 显示端：`/display?project=<id>`

访问地址不带 `project` 时自动使用最早创建的项目。至少保留一个项目。

## 存储后端

通过环境变量 `STORAGE` 选择，默认 `json`：

| STORAGE | 说明 | 相关环境变量 |
|---|---|---|
| `json`（默认） | 状态写入 `data/state.json`，原子写入 | `STATE_FILE` 可指定文件路径 |
| `sqlite` | 表 `scoreboard_state`（WAL 模式） | `SQLITE_FILE`（默认 `data/scoreboard.db`） |
| `postgres` | 表 `scoreboard_state`，启动时自动建表 | `DATABASE_URL` 或标准 `PG*` 变量；`PG_CONNECT_TIMEOUT_MS` |
| `mysql` | 表 `scoreboard_state`，启动时自动建表 | `MYSQL_URL` 或 `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` |

示例：

```bash
STORAGE=sqlite SQLITE_FILE=./data/scoreboard.db npm start
STORAGE=postgres DATABASE_URL=postgres://user:pass@localhost:5432/scoreboard npm start
STORAGE=mysql MYSQL_URL=mysql://user:pass@localhost:3306/scoreboard npm start
```

数据库后端把整份状态作为一个 JSON 快照存入一行（`id='state'`），启动时自动建表；上传的头像文件仍保存在本地 `data/avatars/`。

## 功能

**管理端**
- 顶部「排版设置」按钮打开弹窗集中管理外观；下方预展区可放大/缩小（50%–160%，记忆上次比例）
- 添加/删除人员（姓名 + 可上传头像，不上传则自动生成彩色首字头像）
- 给人员记分：输入分数，点「+分」「−分」（支持负分）
- 创建/删除团队（删除团队不删人，成员自动移出）
- 将人员移入/移出团队（人员列表下拉选择，或团队卡片中点 ×）
- 排版设置：标题、每行列数、卡片密度、排序方式/方向、深浅主题、强调色、成员分数/团队总分显示开关
- 外观设置：背景（跟随主题的纯色 / 自定义背景色 / 上传背景图）、卡片样式（底色自定义、圆角 0–32px、强调色）
- 每张人员/团队卡片可单独上传「卡面」背景图（自动叠盖层保证文字可读）；人员的卡面同样应用到团队内的成员小卡片
- 自由布局：开启后可在「显示端预览」里直接拖动卡片移动位置、拖右下角改宽高；团队内的成员小卡片也可以单独拖动、缩放；拖动时自动显示对齐辅助线并吸附；可一键重置全部位置
- 头像位置：头像在姓名的左 / 右 / 上 / 下可调（作用于个人卡片、团队卡头、成员小卡片）
- 头像大小：可随卡片尺寸自适应，也可手动指定像素大小（24–160px）
- 卡片样式：普通 / 毛玻璃（模糊强度与透明度可调）/ 新拟态 / 霓虹描边 / 渐变 / 纸片
- 记分特效：弹跳 / 发光 / 飘浮数字 / 抖动 / 彩带 / 居中放大突显 / 关闭；时长与颜色可调；可设置仅加分时触发
  - 「居中放大突显」会把被记分的人克隆到屏幕中央放大展示，再缩回原位；突显范围三选一：仅团队 / 人物 + 团队 / 仅人物；突显宽度 200–1600px、高度 0–1200px（0=自动）可调，管理端可一键「预览突显效果」
- 高级外观：字体（黑体/宋体/楷体）、字号缩放、标题字号/对齐/颜色/横线开关、页面最大宽度、卡片间距/内边距/边框宽度与颜色/阴影/团队色条、头像边框与形状、文字颜色、正负分颜色、名次颜色/字号/显示开关、比例条高度/显示开关、背景压暗强度
- 记分音效：内置 Web Audio 合成音（加分上扬、减分下沉），也可上传自定义音效（wav/ogg/mp3/m4a，5MB 内）；音量可调；显示端需点一下页面解锁浏览器音频
- 团队内成员卡大小：0.6–2 倍滑杆统一缩放（拖动单个成员属于更细的单独调整）

**显示端（大屏展板风格）**
- 5 套显示风格：大屏讲演（默认）、PPT 演示、希沃白板、KDE 桌面、自由配置
- 居中大标题 + 强调色短横线，字号与留白按「远处也能看清」设计
- 个人卡片：头像、姓名、大号分数（正绿负红）、分数比例条
- 团队卡片：团队头像、团队名、团队总分（成员分数之和）、成员列表（头像+姓名+分数）
- 按分数从高到低排序时，卡片右上角显示名次；分数比例条按全场最高分归一化
- 管理端任何操作实时同步，分数变化带可配置特效与音效
- 断线自动重连（右上角圆点：绿=已连接，黄=重连中）

## Electron 管理端

Electron 应用只承载**管理端**；显示端有两种打开方式：

```bash
npm run electron        # 开发模式启动 Electron
```

启动后在应用菜单：

- **文件 → 打开显示端窗口**：新建一个显示端窗口（可再开多个，支持 F11 全屏）
- **文件 → 在系统浏览器中打开显示端**：用默认浏览器打开显示端
- **文件 → 新建管理端窗口**：同时管理多个项目/屏幕

Electron 会内嵌启动同一个 HTTP/WS 服务（自动选择空闲端口），管理员在管理端里的「打开显示端」链接也会被拦截为新的显示端窗口。

数据目录改到系统用户数据目录，不再使用项目里的 `data/`：

- Linux：`~/.config/ScreenScoreBoard/data`
- Windows：`%APPDATA%\ScreenScoreBoard\data`
- macOS：`~/Library/Application Support/ScreenScoreBoard/data`

### 打包三端产物

```bash
npm run dist:linux     # AppImage + .deb
npm run dist:win       # NSIS 安装包 + portable
npm run dist:mac       # dmg + zip（必须在 macOS 上执行）
```

产物输出到 `dist/`。WebStorm 里也提供了对应运行配置：**Electron 开发 / 打包 Linux / 打包 Windows / 打包 macOS**。

说明：

- Windows 产物在 Linux 上交叉打包需要 wine；macOS 产物必须在 macOS 上构建
- 未配置代码签名证书，安装包未签名
- 使用默认 Electron 图标，可自行放入 `build/icon.png` 等自行替换
- Electron 内默认使用 JSON 存储；若要在 Electron 里使用 SQLite，需要针对 Electron 的 Node ABI 重新编译 `better-sqlite3`（`npx electron-rebuild better-sqlite3`）

## 验证

```bash
npm run verify   # 端到端：HTTP/上传/WS 同步/多项目/SQLite 存储/旧数据迁移，全部断言通过退出码 0
```

## 数据

- 默认存储在 `data/state.json`，也可切换到 SQLite / PostgreSQL / MySQL（见上）
- 旧版单积分榜数据（`data/state.json` 里直接是 people/teams/settings）启动时自动迁移为「默认项目」
- 上传的头像保存在 `data/avatars/`，上限 2MB，仅支持 png/jpeg/webp/gif
- `DATA_DIR=/path/to/dir npm start` 可更换数据目录

## 结构

```
server/index.js   入口：http 路由、头像上传、挂载 WS
server/state.js   权威状态：多项目、applyOp 校验、防抖串行写盘
server/storage.js 存储后端：json / sqlite / postgres / mysql
server/wss.js     WebSocket：op 分发、全量广播、心跳
server/static.js  静态文件服务（防路径穿越）
public/           display.* 显示端 / admin.* 管理端 / shared.js 共用
scripts/verify.mjs 端到端验证（含多项目、SQLite、旧数据迁移）
```
