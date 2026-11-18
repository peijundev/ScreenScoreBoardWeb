# 实时计分板

显示端 + 管理端的实时计分板网页，Node 原生 http + WebSocket技术栈，不用构建。支持多项目（每个项目一个独立积分榜）和可切换的存储后端（JSON / SQLite / PostgreSQL / MySQL）。

## 为什么做这个项目？

学校活动，让做个大屏幕投票计分板，都折腾两天了，既然都做这么多功能了，那就扔Github吃灰把，要是有用呢？

对吧

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
- 顶部「排版设置」按钮打开非模态窗口（可拖动、可拉右下角调整大小并记忆尺寸）；下方预展区可放大/缩小（50%–160%，记忆上次比例）
- 管理端支持浅色 / 深色切换（右上角「主题」按钮），偏好保存在浏览器本地，刷新后保持；打开多个管理页时同步切换
- 添加/删除/改名人员（点击姓名即可改名；姓名 + 可上传头像，不上传则自动生成彩色首字头像）；**已加入的人员/团队可随时更换或恢复默认头像**
- 批量添加人员：粘贴名单（换行/逗号/顿号/分号/制表符分隔），自动去重并跳过重名
- 人员 / 团队搜索过滤
- 人员 / 团队手动调序：列表中的 ↑↓ 按钮调整顺序，首次调序会自动切换到「自定义顺序」，大屏卡片随即按该顺序展示
- 给人员记分：输入分数，点「+分」「−分」（支持负分），可选 +1/+5/+10/−1 快捷按钮
- 团队整体记分：+1/+5/−1，对每位成员各加减一次
- 撤销上一步记分、一键重置本局分数（均可关闭对应功能）
- 所有新增功能都有独立开关（设置 → 功能开关），可单独隐藏/禁用
- 创建/删除/改名团队（点击团队名即可改名；删除团队不删人，成员自动移出）
- 将人员移入/移出团队（人员列表下拉选择，或团队卡片中点 ×）
- 排版设置：标题、每行列数、卡片密度、排序方式/方向、深浅主题、强调色、成员分数/团队总分显示开关
- 外观设置：背景（跟随主题的纯色 / 自定义背景色 / 上传背景图；背景图可选虚化并调节虚化度 0–40px，所有主题通用；另有「背景遮罩」开关与强度——浅色主题下背景图「发白」就是这层遮罩，可关闭或调弱）、卡片底色（跟随主题 / 自定义纯色 / 半透明 / 亚克力，不透明度与模糊可调）、卡片圆角、强调色
- 团队卡片左侧色条：宽度 0–12px、颜色可自定义、可整体关闭
- 每张人员/团队卡片可单独上传「卡面」背景图（自动叠盖层保证文字可读）；人员的卡面同样应用到团队内的成员小卡片
- 自由布局：开启后可在「显示端预览」里直接拖动卡片移动位置、拖右下角改宽高；团队内的成员小卡片也可以单独拖动、缩放；拖动时自动显示对齐辅助线并吸附；可一键重置全部位置
- 头像位置：头像在姓名的左 / 右 / 上 / 下可调（作用于个人卡片、团队卡头、成员小卡片）
- 头像大小：可随卡片尺寸自适应，也可手动指定像素大小（24–160px）
- 卡片样式：普通 / 毛玻璃（模糊强度与透明度可调）/ 新拟态 / 霓虹描边 / 渐变 / 纸片
- 记分特效：弹跳 / 发光 / 飘浮数字 / 抖动 / 彩带 / 居中放大突显 / 关闭；时长与颜色可调；可设置仅加分时触发
  - 「居中放大突显」会把被记分的人克隆到屏幕中央放大展示，再缩回原位；突显范围三选一：仅团队 / 人物 + 团队 / 仅人物；突显宽度 200–1600px、高度 0–1200px（0=自动）可调，管理端可一键「预览突显效果」
  - 可选「从原位置飞入居中，再飞回原位」动画；飞入飞回时长可单独设置（600–6000ms），不受普通特效时长影响
- 高级外观：字体（黑体/宋体/楷体/自定义系统字体，支持手动输入任意字体名，Chrome 系可一键「读取系统字体」列出本机字体）、字号缩放、标题字体（可独立于正文，支持预设/自定义系统字体）/字号/对齐/颜色/横线开关、页面最大宽度、卡片间距/内边距/边框宽度与颜色/阴影/团队色条、头像边框与形状、文字颜色、正负分颜色、名次颜色/字号/显示开关、比例条高度/显示开关、背景压暗强度
- 记分音效：内置 Web Audio 合成音（加分上扬、减分下沉），也可上传自定义音效（wav/ogg/mp3/m4a，5MB 内）；音量可调；显示端需点一下页面解锁浏览器音频
- 团队内成员卡大小：0.6–2 倍滑杆统一缩放（拖动单个成员属于更细的单独调整）

**显示端（大屏展板风格）**
- 11 套显示风格：大屏讲演（默认）、PPT 演示、希沃白板、KDE 桌面、古风雅集、水墨、真·古风、现代极简、赛博霓虹、海报展板、自由配置
- 真·古风风格：宣纸底 + 远山云雾、行楷标题与金色云纹标题线；**卡片强制使用内置卷轴卡面**（棕金 / 樱粉 / 竹青 / 朱红四色按卡片顺序轮换，素材在 `public/img/xianxia/`），卡片样式、底色、圆角、边框，以及记分特效（弹跳/发光/彩带/突显/聚光灯）、排序/名次动画在本主题下一律禁用
- 每个风格都可自由覆盖排版：标题对齐（跟随风格/居中/居左/居右）、标题装饰（跟随风格/纯标题去掉胶囊/竖条）、「风格自由配置」开关让高级外观设置覆盖风格皮肤的固定圆角/阴影/边框
- 标题自由位置：开启后可在管理端预览里把标题拖到屏幕任意位置，坐标按视口百分比保存，可一键重置
- 居中大标题 + 强调色短横线，字号与留白按「远处也能看清」设计
- 个人卡片：头像、姓名、大号分数（正绿负红）、分数比例条
- 团队卡片：团队头像、团队名、团队总分（成员分数之和）、成员列表（头像+姓名+分数）
- 按分数从高到低排序时，卡片右上角显示名次；分数比例条按全场最高分归一化；支持并列名次（竞赛式 1,1,3 / 密集式 1,1,2 / 顺序 1,2,3）
- 字体可调：标题、时钟、倒计时、排行榜、跑马灯、欢迎幕布、分数数字均可单独选择字体（预设 / 自定义系统字体）与字号，各部分互不影响
- 时钟（四角位置、12/24 小时、秒、日期可配）与倒计时（开始/暂停/继续/重置，刷新后恢复，结束时红色闪烁）；倒计时可选角落小窗 / 居中大窗口 / 全屏三种显示模式
- 居中大窗口可自定义：圆形 / 方形 / 圆角方形 / 圆角矩形 / 矩形、圆角 0–120px、宽度 200–900px、高度 0–900px（0=与宽度相同；圆形和方形固定等宽高）、数字字号 0–300px（0=自动）、九宫格位置、窗口背景（跟随主题 / 自定义颜色 / 半透明 / 亚克力半透明虚化，模糊强度可调）、文字颜色、进度环和背景遮罩开关
- 倒计时主题：
  - **经典**：原有圆环/矩形窗口样式
  - **水墨（静态画面）**：宣纸底 + 墨爆晕染 + 墨枝粉樱 + 飘落花瓣的满屏水墨画面（素材取自原片，数字为白色 Times 衬线体，居中于墨盘，带呼吸动画；数字字号可手动覆盖）
  - **水墨影片（原片）**：直接播放原始视频（`public/media/ink-countdown.mp4`），画面、花瓣、数字全部与原片一致；播放倍速按倒计时总时长自适应，保证与倒计时同时结束；右下角显示真实剩余时间；开始/暂停/继续/重置与倒计时状态同步
- 大字排行榜视图：仅人员 / 仅团队 / 自动，条数与缩放可调；支持 `?view=leaderboard` 强制显示、`?view=board` 强制返回展板
- 管理端任何操作实时同步，分数变化带可配置特效与音效
- 断线自动重连（右上角圆点：绿=已连接，黄=重连中）

## 数据导出与备份

管理端「数据」区（可在功能开关中隐藏）：

- **导出项目**：`GET /api/export?project=<id>&assets=1`，下载包含项目数据与头像/音效的 JSON
- **导入项目**：`POST /api/import`，生成一个新项目；严格校验设置、布局、团队引用与资产魔数，失败不改变现有数据
- **导出分数 CSV**：`GET /api/scores.csv?project=<id>&scope=all|people|teams`，UTF-8 BOM + CRLF，Excel 直接打开不乱码
- **立即备份**：`POST /api/backups/run`，默认写入 `data/backups/state-时间.json`
- **扫描/清理废弃文件**：`GET /api/orphans`、`POST /api/orphans/cleanup`，只删除超过宽限期且未被任何项目引用的头像/音效

自动备份与自动清理通过环境变量控制（服务级，不随项目）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `BACKUP_ENABLED` | `1` | `0` 关闭自动备份（手动备份仍可用） |
| `BACKUP_INTERVAL_MINUTES` | `30` | 自动备份间隔（分钟），0 关闭 |
| `BACKUP_KEEP` | `20` | 保留最近多少份备份 |
| `BACKUP_DIR` | `data/backups` | 备份目录 |
| `ORPHAN_CLEANUP_ENABLED` | `0` | `1` 开启每天自动清理孤儿文件 |
| `ORPHAN_CLEANUP_GRACE_HOURS` | `24` | 文件至少存在多少小时才可被自动清理 |

> 安全提示：当前版本没有管理端登录与权限校验，导出/导入/清理接口与现有管理端一样，只适合部署在可信局域网或反向代理鉴权之后。

## 部署（Docker / systemd）

Docker：

```bash
docker compose up -d --build
# 数据与备份持久化在 ./data，服务暴露 3000 端口
```

也可以直接使用：

```bash
docker build -t screen-scoreboard .
docker run -d -p 3000:3000 -v ./data:/data screen-scoreboard
```

systemd：

```bash
sudo useradd -r -s /usr/sbin/nologin scoreboard
sudo mkdir -p /opt/screenscoreboard /var/lib/screenscoreboard
sudo cp -r server public package*.json /opt/screenscoreboard/
cd /opt/screenscoreboard && sudo npm ci --omit=dev
sudo cp deploy/screenscoreboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now screenscoreboard
```

环境变量可写入 `/etc/screenscoreboard/env`（systemd 单元已通过 `EnvironmentFile` 读取）。

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
server/index.js   入口：http 路由、上传、导出/导入/CSV/备份/清理 API、挂载 WS
server/state.js   权威状态：多项目、applyOp 校验、防抖串行写盘、导入清洗
server/runtime.js 运行时态：撤销栈、倒计时、广播快照（仅内存）
server/storage.js 存储后端：json / sqlite / postgres / mysql
server/wss.js     WebSocket：op 分发、全量广播（含 runtime）、心跳
server/backup.js  自动备份
server/cleanup.js 孤儿上传文件清理
server/static.js  静态文件服务（防路径穿越）
public/           display.* 显示端 / admin.* 管理端 / shared.js 共用
scripts/verify.mjs 端到端验证（120+ 断言）
Dockerfile / docker-compose.yml / deploy/screenscoreboard.service 部署
```
