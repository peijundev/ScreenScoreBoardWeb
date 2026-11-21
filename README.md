# 实时计分板

显示端 + 管理端的实时计分板。后端为 Node 原生 http + WebSocket；前端为 React 19 + Vite + TypeScript（源码在 `web/`，构建产物在 `public/v2/`）。支持多项目（每个项目一个独立积分榜）和可切换的存储后端（JSON / SQLite / PostgreSQL / MySQL）。

> ## 版本 1.6.3 — Node.js 24 基线
>
> - **破坏性变更**：最低 Node.js 版本提升到 24，不再支持 Node 20 / 22；升级后需重新安装依赖，并用 Node 24 重建 `better-sqlite3`
> - **改进**：`@types/node` 对齐 24.x；`test:theme` 纳入 CI；Dockerfile 支持 `NODE_VERSION` 构建参数，并修复 Vite 8 rolldown 原生绑定导致的镜像构建失败
> - **延续 1.6.2**：Electron 启动页三模式（本地 / 远程管理 / 远程屏幕），远程管理只填服务器地址 / 账号 / 密码，远程屏幕只填完整显示端网址
> - **延续 1.6.1**：纯突显（不加分）、官方 npm SDK（REST + MCP）、部署模式访问控制（可关闭登录系统，完全开放）
> - **延续 1.6.0**：完整多用户鉴权（管理员 / 操作员 / 只读）、CSRF、会话与 API 令牌、HTTPS、Electron 本地/远程双模式与运行中返回欢迎页
> - **延续 1.5.2**：REST API v1（90+ 条端点，含鉴权 + OpenAPI 3.1）、MCP（HTTP / stdio，90 个业务工具）、手机全功能管理端
> - **1.4.0 已封存**：原技术栈（零构建、原生 DOM 前端）的最终版本，不再更新，历史说明见 [CHANGELOG.md](CHANGELOG.md)。
> - **1.5.0 起**：前端为 React 19 + Vite + TypeScript（源码 `web/`，构建产物 `public/v2/`）；后端仍为 Node 原生 http + WebSocket。
> - `data/` 数据格式、存储后端与 WS 协议与 1.5.0 兼容，可直接升级；首次运行 `npm start` 会自动构建前端。

## 为什么做这个项目？

学校活动，让做个大屏幕投票计分板，都折腾两天了，既然都做这么多功能了，那就扔Github吃灰吧，正好还能用CI，要是有人真的会去用呢？ 对吧

## 启动

```bash
npm install
npm start          # prestart 会自动构建 React 前端，然后启动服务
```

- 显示端（大屏）：http://localhost:3000/display（公开只读）
- 管理端（控制台）：http://localhost:3000/admin（需要登录）

首次启动请设置 `ADMIN_PASSWORD='至少 8 位的密码' npm start`，或只在本机打开管理端完成初始化。远程部署请阅读 [docs/authentication.md](docs/authentication.md)。

也可以分开执行：`npm run build:web` 构建前端，`npm run start:build` 一步构建并启动。

局域网内其他设备用本机 IP 访问同一地址即可。端口可用 `PORT=8080 npm start` 修改。

Node 版本要求 **24+**（`package.json` 已声明 `engines.node: ">=24"`），项目用 `.nvmrc` 固定为 24。`npm run test:theme` 直接加载 `.ts` 源码，依赖 Node 24 的原生 TypeScript 类型剥离。如果切换了 Node 大版本，使用 SQLite 后端前需要重新编译原生模块：

```bash
npm rebuild better-sqlite3
```

## 技术栈（1.5.0 起）

1.5.0 起前端完全使用 React（源码在 `web/`）；1.4.0 的原生 JS 前端已封存并从代码库移除。后端与 WebSocket 协议保持不变。

- 入口：`/admin`、`/display`（`/admin-v2`、`/display-v2` 为等价别名）
- 未构建 `public/v2/` 时，页面会提示先执行 `npm run build:web`
- `npm start` 会通过 `prestart` 自动构建前端；也可用 `npm run start:build`
- 开发：终端 A `npm start`（后端 3000），终端 B `npm run dev:web`，打开 http://localhost:5173/admin.html
- 构建：`npm run build:web` 产出 `public/v2/`（已被 `.gitignore` 忽略；Electron 打包与 npm 发布会自动构建）
- 类型检查：`npm run typecheck`

技术基线：React 19 + Vite + TypeScript + Zustand；CSS 与 `body[data-*]` 主题体系沿用旧版。构建与运行统一要求 Node 24+，推荐直接用 `.nvmrc` 的 24。

**IDE 运行配置**（`.idea/runConfigurations/`）：按「调试 / 启动 / 开发 / 构建 / 检查 / 测试 / 打包」分组；调试类配置使用 IDE 原生 Node.js / Chrome 调试，可直接下断点，其余为日常启动、构建与测试。

- 后端：`调试 · 后端`（Node.js 配置，直接在 `server/*.js` 下断点）。它使用独立数据目录 `data/debug`，不会和正在运行的服务抢单实例锁；首次调试需要重新初始化管理员，也可以用 `工具 · 重置密码（调试库）` 重置。
- 前端：`调试 · 前端 Admin` / `调试 · 前端 Display` 会自动拉起 `开发 · Vite`（Chrome 调试，`.tsx` 源码断点）。Vite 固定 5173，端口被占用时会直接失败而不是漂移到 5174。需要手动先起 Vite 时用带「仅附加」后缀的配置。
- 全栈：`调试 · 全栈（后端 + Vite + Admin）` 一次拉起后端断点、Vite 与 Admin 浏览器调试；`调试 · 全栈（后端 + Vite）` 不自动打开浏览器。
- 测试：`调试 · 测试 API/MCP/手机端/认证/Electron 模式/Electron 缩放/SDK 客户端` 可直接在测试脚本与业务代码中断点；日常跑全量用 `测试 · 全部`，SDK 用 `测试 · SDK`。
- 测试里的后端子进程：`调试 · 测试 API（含子进程）` / `调试 · 测试 MCP（含子进程）` 会通过 `NODE_OPTIONS=--inspect=9332/9333` 让测试 `spawn` 的服务监听调试端口，再运行 `调试 · 附加 Node 9332/9333` 即可在 `server/*.js` 下断点。
- Electron：`启动 · Electron（可附加）` 以 `--inspect=9331 --remote-debugging-port=9222` 启动，主进程用 `调试 · Electron 主进程（9331）` 附加，渲染进程用 `调试 · Electron 渲染进程（9222）`。渲染进程要按 `.tsx` 断点需先跑 `构建 · 前端（SourceMap）`（默认构建不产出 sourcemap）。
- 接口调试：`http/` 下有 WebStorm HTTP Client 集合。复制 `http-client.private.env.json.example` 为 `http-client.private.env.json` 并填入管理员密码（该文件已被 Git 忽略），然后按顺序运行 `screenscoreboard.http` 的登录 → 令牌 → 项目 → 人员 → 记分，再用 `mcp.http` 调 MCP。
- 其他：`调试 · 验证脚本`、`调试 · MCP stdio`、`启动 · 计分板`、`启动 · 构建并启动`、`开发 · Electron`、`构建 · 前端`、`构建 · SDK`、`构建 · 契约（写入 generated）`、`检查 · 类型/Lint`、`检查 · 格式化（写入）`、`测试 · 主题`、`工具 · 重置密码（调试库）` 与三平台/通用打包。

新增 npm script 时同步补充对应运行配置。

## 多项目

管理端顶部可以新建 / 重命名 / 删除项目，每个项目拥有独立的人员、团队、分数和全部外观设置。切换项目后，管理端预览和显示端链接会自动带上 `?project=<项目id>`：

- 管理端：`/admin?project=<id>`
- 显示端：`/display?project=<id>`

访问地址不带 `project` 时自动使用最早创建的项目。至少保留一个项目。

## REST API、MCP 与手机管理端

- **REST API v1**：`/api/v1` 覆盖项目、人员、团队、分数、手动突显、设置、运行态、主题库与主题子资源、主题草稿、导入导出、上传、备份和低层 `op`。所有写操作都走同一 `applyOp` 入口，并通过 WebSocket 实时同步。机器可读契约：`GET /api/v1/openapi.json`（OpenAPI 3.1）。
- **MCP**：`POST /mcp`（HTTP）与 `bin/screenscoreboard-mcp.js`（stdio）两种形态，共用同一套工具定义，可直接被 Claude Desktop / Claude Code / 自研 AI 客户端调用。
- **手机管理端**：管理端在 ≤860px 自动切换为底部标签布局，全部功能（含主题工作室与矢量编辑）可用；对话框全屏、触控目标可调。

```bash
# REST 冒烟
curl http://localhost:3000/api/v1/health

# stdio MCP（需先启动服务，并创建管理员 API 令牌）
SCOREBOARD_URL=http://127.0.0.1:3000 SCOREBOARD_TOKEN=ssb_xxx node bin/screenscoreboard-mcp.js
```

文档：[API v1](docs/api-v1.md) · [MCP](docs/mcp.md) · [手机管理端](docs/mobile-admin.md) · [安全说明](docs/security-notes.md)

## SDK（Node / 浏览器 / AI 接入）

独立 npm 包 `@peijundev/screenscoreboard-sdk` 同时封装 REST API v1 与 MCP，零运行时依赖，自带 TypeScript 类型：

```bash
npm install @peijundev/screenscoreboard-sdk
```

```ts
import { ScreenScoreBoardClient } from '@peijundev/screenscoreboard-sdk';

const client = new ScreenScoreBoardClient({
  baseUrl: 'https://score.example.com',
  token: process.env.SCOREBOARD_TOKEN,
});

const projects = await client.projects.list();
const person = await client.people.add(projects[0].id, { name: '张三' });
await client.people.addScore(projects[0].id, person.id, 5);
await client.spotlight.person(projects[0].id, person.id); // 纯突显，不加分

// MCP：给 AI 使用同一套工具
const tools = await client.mcp.listTools();
await client.mcp.callToolOrThrow('add_score', {
  projectId: projects[0].id, personId: person.id, delta: 1,
});
```

- 支持 API 令牌、账号密码会话、Cookie + CSRF、401 自动重登、请求超时与取消
- 覆盖项目 / 人员 / 团队 / 分数 / 手动突显 / 设置 / 运行态 / 主题 / 草稿 / 资源库 / 备份
- 未封装端点可用 `client.request(method, path, options)` 直接访问
- MCP 支持 `initialize`、`tools/list`、`tools/call`、`resources/read`，可直接把工具定义交给 AI

完整文档：[packages/sdk/README.md](packages/sdk/README.md)

本仓库内验证：

```bash
npm run sdk:build
npm run sdk:test
npm run sdk:pack
```

> **安全提示：** 本版本已内置账号、角色、会话与 API 令牌鉴权。首次启动请设置 `ADMIN_PASSWORD`，或只在本机打开管理端完成初始化；远程部署请置于 HTTPS 反向代理之后。管理员也可在「账号与安全 → 访问控制」关闭登录系统（完全开放，所有访问者拥有管理员权限），仅建议在可信局域网 / VPN 使用。完整说明见 [docs/authentication.md](docs/authentication.md)。应用内明确不做 WS/HTTP 限流。

## 存储后端

支持 9 种后端，可在管理端「存储后端」中可视化选择、填写连接参数、测试连接、迁移数据并保存；也可以继续用环境变量 `STORAGE` 配置。默认 `json`。

| STORAGE | 说明 | 相关环境变量 |
|---|---|---|
| `json`（默认） | 状态写入 `data/state.json`，原子写入 | `STATE_FILE`、`STATE_FILE_PRETTY` |
| `txt` | 状态以缩进 JSON 写入 `data/state.txt`，便于人工查看 | `STATE_TXT_FILE` |
| `sqlite` | 表 `scoreboard_state`（WAL 模式、revision CAS） | `SQLITE_FILE`、`SQLITE_BUSY_TIMEOUT_MS` |
| `postgres` | 表 `scoreboard_state`，启动自动建表；支持 advisory lock | `DATABASE_URL` 或标准 `PG*` 变量；`PG_CONNECT_TIMEOUT_MS` |
| `mysql` | 表 `scoreboard_state`，启动自动建表；支持 `GET_LOCK` | `MYSQL_URL` 或 `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` |
| `mongodb` | 集合 `scoreboard_state`，单文档快照；单文档上限 16MB | `MONGODB_URL` / `MONGO_URL`、`MONGODB_DB` |
| `sqlserver` | 表 `dbo.scoreboard_state`，纯 JS `mssql` 驱动 | `MSSQL_URL` 或 `MSSQL_SERVER` / `MSSQL_PORT` / `MSSQL_USER` / `MSSQL_PASSWORD` / `MSSQL_DATABASE` |
| `oracle` | 表 `scoreboard_state`，`oracledb` Thin 模式（无需 Instant Client） | `ORACLE_URL` 或 `ORACLE_CONNECT_STRING` / `ORACLE_USER` / `ORACLE_PASSWORD` |
| `redis` | Hash 快照 + Lua CAS；支持分布式锁 | `REDIS_URL` 或 `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` |

示例：

```bash
STORAGE=txt npm start
STORAGE=sqlite SQLITE_FILE=./data/scoreboard.db npm start
STORAGE=postgres DATABASE_URL=postgres://user:pass@localhost:5432/scoreboard npm start
STORAGE=redis REDIS_URL=redis://localhost:6379/0 npm start
```

### 管理端可视化配置（推荐）

管理员在管理端打开「存储后端」即可：

1. 选择后端并填写连接参数；
2. 「测试连接」确认可达与目标是否已有数据；
3. 选择「迁移现有数据」或「新后端从空库开始」；
4. 保存后**重启服务**生效。

存储配置独立保存在 `DATA_DIR/storage.json`，优先级高于存储相关环境变量，文件权限 `0600`；数据库密码不会通过 API 回传前端，也不会进入项目状态、广播、导出或备份。配置文件损坏时服务会拒绝启动（fail-closed），修复或移走该文件即可回退到环境变量/默认 JSON。

> **Redis 作为权威存储**必须开启 AOF（`appendonly yes`，`appendfsync everysec` 或 `always`）并设置 `maxmemory-policy noeviction`，否则重启或内存淘汰可能丢失状态。无法保证持久化时建议选择 PostgreSQL。
>
> **MongoDB** 单文档上限 16MB；项目与主题库接近上限时迁移会明确失败，请改用关系型数据库。

数据库后端把整份状态作为一个 JSON 快照存入一行/一个文档，启动时自动建表；账号/会话仍在 `DATA_DIR/auth.json` / `sessions.json`，上传的头像与音效仍保存在本地 `data/avatars/`、`data/sounds/`。跨主机分布式锁只保证单写者，不提供多副本同时对外服务。

详细字段、迁移与排错见 [docs/storage-backends.md](docs/storage-backends.md)。

## 后端运行配置

除存储相关变量（见上一节）外，后端支持以下环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址；Electron 内部固定使用 `127.0.0.1` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `text` | `text` 或 `json`（便于日志采集） |
| `SLOW_OP_MS` | `100` | 慢 op 告警阈值 |
| `BROADCAST_COALESCE_MS` | `50` | WebSocket 广播合并窗口，`0` 关闭合并 |
| `BROADCAST_LARGE_COALESCE_MS` | `250` | 大状态（默认 >150KB）使用的合并窗口，优先流畅度 |
| `BROADCAST_LARGE_BYTES` | `153600` | 判定“大状态”的广播体积阈值 |
| `WS_MAX_CONNECTIONS` | `200` | 最大 WebSocket 连接数 |
| `WS_MAX_BUFFERED_BYTES` | `1048576` | 单连接发送积压上限（背压） |
| `WS_PERMESSAGE_DEFLATE` | `1` | 是否启用 WebSocket 压缩 |
| `WS_DEFLATE_THRESHOLD` | `1024` | 小于该字节数的消息不压缩 |
| `STATE_FILE_PRETTY` | `0` | JSON 存盘是否使用缩进（默认 compact） |
| `SHUTDOWN_FLUSH_TIMEOUT_MS` | `10000` | 退出时落盘超时 |
| `MAX_IMPORT_BYTES` | `67108864` | 项目导入请求体上限 |
| `ALLOWED_ORIGINS` | 空 | 额外允许的 Origin（逗号分隔；同源始终允许） |
| `ALLOW_MULTI_INSTANCE` | `0` | `1` 时跳过单实例锁（可能导致数据覆盖，仅调试用） |
| `ADMIN_USERNAME` | `admin` | 首次用环境变量创建管理员时的用户名 |
| `ADMIN_PASSWORD` | 空 | 仅在没有任何用户时创建首个管理员；已有用户时忽略 |
| `ADMIN_PASSWORD_FILE` | 空 | 从文件读取初始密码（适合 systemd/Docker secret，优先于 `ADMIN_PASSWORD`） |
| `SESSION_TTL_HOURS` | `24` | 普通会话有效期 |
| `SESSION_REMEMBER_DAYS` | `30` | 「记住我」有效期 |
| `COOKIE_SECURE` | `auto` | `auto` / `true` / `false`；auto 按 TLS 或反代协议判断 |
| `TRUST_PROXY` | `0` | 置于 HTTPS 反向代理后设为 `1`，读取 `X-Forwarded-*` |
| `TLS_CERT_FILE` | 空 | 可选，Node 内置 HTTPS 证书 |
| `TLS_KEY_FILE` | 空 | 可选，Node 内置 HTTPS 私钥 |
| `TLS_PASSPHRASE` | 空 | 可选，私钥口令 |
| `SCOREBOARD_TOKEN` | 空 | stdio MCP / 自动化客户端使用的 API 令牌 |
| `SCOREBOARD_MODE` | `local` | Electron：`local` / `remote-admin` / `remote-display`（旧 `remote` 兼容为 `remote-admin`） |
| `SCOREBOARD_REMOTE_URL` | 空 | Electron 远程管理模式服务器地址（兼容 `SCOREBOARD_URL`） |
| `SCOREBOARD_DISPLAY_URL` | 空 | Electron 远程屏幕模式的完整显示端网址 |

- 健康检查：`GET /api/health` 返回版本、运行时长、存储类型与 WS 连接数，不返回全量状态
- 单实例锁：默认拒绝两个进程同时使用同一 `DATA_DIR`；陈旧锁（进程已退出）会自动清理
- WebSocket 默认校验 Origin（同源放行，跨站拒绝）
- 基础安全响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`
- 优化路线与实测数据见 [docs/backend-optimization.md](docs/backend-optimization.md)

## 功能

**管理端**
- 访问控制：管理员可在「账号与安全 → 访问控制」关闭登录系统（完全开放，所有访问者拥有管理员权限）或重新启用；设置持久化到 `auth.json`，仅建议在可信局域网 / VPN 使用
- 顶部「排版设置」按钮打开非模态窗口（可拖动、可拉右下角调整大小并记忆尺寸）；下方预展区可放大/缩小（50%–160%，记忆上次比例）
- 管理端支持浅色 / 深色切换（右上角「主题」按钮），偏好保存在浏览器本地，刷新后保持；打开多个管理页时同步切换
- 添加/删除/改名人员（点击姓名即可改名；姓名 + 可上传头像，不上传则自动生成彩色首字头像）；**已加入的人员/团队可随时更换或恢复默认头像**
- 批量添加人员：粘贴名单（换行/逗号/顿号/分号/制表符分隔），自动去重并跳过重名
- 人员 / 团队搜索过滤
- 人员 / 团队手动调序：列表中的 ↑↓ 按钮调整顺序，首次调序会自动切换到「自定义顺序」，大屏卡片随即按该顺序展示
- 给人员记分：输入分数，点「+分」「−分」（支持负分），可选 +1/+5/+10/−1 快捷按钮
- 纯突显（不加分）：人员行 / 团队行的「突显」按钮，或 `POST /api/v1/projects/:id/spotlight`，在不改变分数的情况下让大屏居中放大突显指定对象；可在功能开关中关闭，时长与既有突显主题参数均可调
- 团队整体记分：+1/+5/−1，对每位成员各加减一次
- 撤销上一步记分、一键重置本局分数（均可关闭对应功能）
- 所有新增功能都有独立开关（设置 → 功能开关），可单独隐藏/禁用
- 创建/删除/改名团队（点击团队名即可改名；删除团队不删人，成员自动移出）
- 将人员移入/移出团队（人员列表下拉选择，或团队卡片中点 ×）
- 排版设置：标题、每行列数、卡片密度、排序方式/方向、深浅主题、强调色、成员分数/团队总分显示开关
- 排版设置按「版式 / 外观 / 字体 / 特效」分标签页
- 主题编辑器：选择基础风格并调整视觉设置（实时预览），支持导入 / 导出主题；格式规范见 [docs/theme-spec.md](docs/theme-spec.md)
- 外观设置：背景（跟随主题的纯色 / 自定义背景色 / 上传背景图；背景图可选虚化并调节虚化度 0–40px，所有主题通用；另有「背景遮罩」开关与强度——浅色主题下背景图「发白」就是这层遮罩，可关闭或调弱）、卡片底色（跟随主题 / 自定义纯色 / 半透明 / 亚克力，不透明度与模糊可调）、卡片圆角、强调色
- 团队卡片左侧色条：宽度 0–12px、颜色可自定义、可整体关闭
- 每张人员/团队卡片可单独上传「卡面」背景图（自动叠盖层保证文字可读）；人员的卡面同样应用到团队内的成员小卡片
- 自由布局：开启后可在「显示端预览」里直接拖动卡片移动位置、拖右下角改宽高；团队内的成员小卡片也可以单独拖动、缩放；拖动时自动显示对齐辅助线并吸附；可一键重置全部位置
- 头像位置：头像在姓名的左 / 右 / 上 / 下可调（作用于个人卡片、团队卡头、成员小卡片）
- 头像大小：可随卡片尺寸自适应，也可手动指定像素大小（24–160px）
- 简介：人员和团队可分别设置最多 60 字的简介，显示在卡片上；可整体开关，并支持单独设置字体、字号、颜色、不透明度与斜体
- 卡片样式：普通 / 毛玻璃（模糊强度与透明度可调）/ 新拟态 / 霓虹描边 / 渐变 / 纸片
- 记分特效：弹跳 / 发光 / 飘浮数字 / 抖动 / 彩带 / 居中放大突显 / 关闭；时长与颜色可调；可设置仅加分时触发
  - 「居中放大突显」会把被记分的人克隆到屏幕中央放大展示，再缩回原位；突显范围三选一：仅团队 / 人物 + 团队 / 仅人物；突显宽度 200–1600px、高度 0–1200px（0=自动）可调，管理端可一键「预览突显效果」
  - 可选「从原位置飞入居中，再飞回原位」动画；飞入飞回时长可单独设置（600–6000ms），不受普通特效时长影响
- 高级外观：字体（黑体/宋体/楷体/自定义系统字体，支持手动输入任意字体名，Chrome 系可一键「读取系统字体」列出本机字体）、字号缩放、标题字体（可独立于正文，支持预设/自定义系统字体）/字号/对齐/颜色/横线开关、页面最大宽度、卡片间距/内边距/边框宽度与颜色/阴影/团队色条、头像边框与形状、文字颜色、正负分颜色、名次颜色/字号/显示开关、比例条高度/显示开关、背景压暗强度
- 记分音效：内置 Web Audio 合成音（加分上扬、减分下沉），也可上传自定义音效（wav/ogg/mp3/m4a，5MB 内）；音量可调；显示端需点一下页面解锁浏览器音频
- 团队内成员卡大小：0.6–2 倍滑杆统一缩放（拖动单个成员属于更细的单独调整）

**显示端（大屏展板风格）**
- 11 套显示风格：古风雅集（默认）、大屏讲演、PPT 演示、希沃白板、KDE 桌面、水墨、真·古风、现代极简、赛博霓虹、海报展板、自由配置
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

> 安全提示：导出、导入、备份与清理接口需要管理员登录；显示端仍然公开只读。远程部署请使用 HTTPS，详见 [docs/authentication.md](docs/authentication.md)。

## 部署（Docker / Podman / Kubernetes / systemd）

所有方式都要求 **Node 24+**。运行镜像基于 Alpine（约 200 MB），Docker、Docker Rootless、Podman、Dev Container 与 Kubernetes 的完整说明见 [docs/containers.md](docs/containers.md)，K8s 从零部署步骤见 [deploy/k8s/README.md](deploy/k8s/README.md)。

Docker：

```bash
# 首次启动必须提供管理员密码（容器内请求不是 loopback，网页初始化会被拒绝）
ADMIN_PASSWORD='至少 8 位的强密码' docker compose up -d --build
# 数据、备份与 auth.json 持久化在 ./data，服务暴露 3000 端口
```

也可以直接使用：

```bash
docker build -t screen-scoreboard .
docker run -d -p 3000:3000 -v ./data:/data \
  -e ADMIN_PASSWORD='至少 8 位的强密码' \
  screen-scoreboard
```

镜像的 Node 版本由 `NODE_VERSION` 构建参数控制（默认 `24`），需要固定到具体小版本时：

```bash
docker build --build-arg NODE_VERSION=24.22.3 -t screen-scoreboard .
```

systemd：

```bash
sudo useradd -r -s /usr/sbin/nologin scoreboard
sudo mkdir -p /opt/screenscoreboard /var/lib/screenscoreboard
sudo cp -r server public bin package*.json /opt/screenscoreboard/
# 前端构建需要 devDependencies（Vite）；构建完成后再裁掉
cd /opt/screenscoreboard && sudo npm ci && sudo npm run build:web && sudo npm prune --omit=dev
sudo cp deploy/screenscoreboard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now screenscoreboard
```

环境变量可写入 `/etc/screenscoreboard/env`（systemd 单元已通过 `EnvironmentFile` 读取）。首次启动前请写入 `ADMIN_PASSWORD`，并把文件权限设为 0600：

```bash
sudo install -m 600 /dev/null /etc/screenscoreboard/env
echo "ADMIN_PASSWORD=至少8位的强密码" | sudo tee /etc/screenscoreboard/env >/dev/null
```

## Electron 管理端（本地 / 远程管理 / 远程屏幕）

Electron 应用同时承载**管理端**和显示端窗口。**每次启动都会先显示模式选择页**：

- **本地模式（原行为）**：内嵌启动同一个 HTTP/WS 服务，自动选择空闲端口，只绑定 `127.0.0.1`；本地模式关闭鉴权，管理端与显示端都无需登录。
- **远程管理模式**：填写三项：远程服务器根地址、账号、密码。Electron 先调用远程 `/api/v1/auth/login` 登录，把会话 Cookie 写入 Electron 默认会话，然后加载远程 `/admin`。管理端里的显示端窗口默认使用服务器根地址 + `/display`。
- **远程屏幕模式**：只需要填写一项完整显示端网址（可以是任意 http/https 页面，不要求与服务器同源）。显示端窗口就是一个无标签页、无地址栏的浏览器，直接加载这个网址；不需要登录。

密码只用于本次登录，不会保存；服务器地址、账号、显示端网址会保存到配置文件。旧配置里的 `mode: "remote"` 会自动迁移为远程管理模式。

```bash
npm run electron        # 开发模式启动 Electron（preelectron 会先构建前端）
```

启动后可以随时切换：

- **管理端顶栏「切换模式」按钮**（手机端在「更多」里）：关闭当前管理/显示窗口，回到欢迎页重新选择模式；本地服务端会保留复用，不会丢数据。
- **服务器 → 退出到欢迎页（切换模式）…**（快捷键 `Ctrl/Cmd+Shift+M`）：同上；远程屏幕模式也使用这个菜单。
- **服务器 → 重启应用…**：完全重启后再选择。
- **服务器 → 重新连接 / 重新加载显示端**：管理模式重新加载管理端，屏幕模式重新加载显示端。
- **文件 → 打开显示端窗口**：管理模式新建一个显示端窗口（默认为服务器地址 + `/display`；可再开多个，支持 F11 全屏）。
- **文件 → 在系统浏览器中打开显示端**。

显示端窗口支持浏览器式缩放，适合接不同分辨率的电视 / 投影 / 大白板时微调画面：

- `Ctrl/Cmd + 滚轮`、`Ctrl/Cmd + +`（放大）、`Ctrl/Cmd + -`（缩小）、`Ctrl/Cmd + 0`（实际大小），也可以使用「视图」菜单里的三个缩放项。
- 范围 50%–300%，每档 10%；缩放作用于整个页面，布局会一起等比变化。
- 比例只保留在当前窗口，关闭窗口或重启应用后回到 100%，不会写入配置文件。
- **文件 → 新建管理端窗口**。

远程管理模式要求服务器根地址是非本机时使用 HTTPS；自签证书需要先在操作系统/Electron 信任链中安装。显示端网址允许 HTTP，因为它不携带管理端凭据。也可用环境变量预填启动页：

```bash
# 远程管理模式
SCOREBOARD_MODE=remote-admin \
SCOREBOARD_REMOTE_URL=https://score.example.com \
SCOREBOARD_USERNAME=admin \
npm run electron

# 远程屏幕模式（不需要账号密码）
SCOREBOARD_MODE=remote-display \
SCOREBOARD_DISPLAY_URL=https://score.example.com/display?project=pr_xxx \
npm run electron
```

远程管理模式启动页仍会要求输入密码；远程屏幕模式只要求确认显示端网址。也可以用菜单随时切换。

本地模式的数据目录在系统用户数据目录，不使用项目里的 `data/`：

- Linux：`~/.config/ScreenScoreBoard/data`
- Windows：`%APPDATA%\ScreenScoreBoard\data`
- macOS：`~/Library/Application Support/ScreenScoreBoard/data`

### 打包三端产物

```bash
npm run dist:linux     # AppImage + .deb
npm run dist:win       # NSIS 安装包 + portable
npm run dist:mac       # dmg + zip（必须在 macOS 上执行）
```

产物输出到 `dist/`。WebStorm 里也提供了对应运行配置：**开发 · Electron / 打包 · Linux / 打包 · Windows / 打包 · macOS**。

说明：

- Windows 产物在 Linux 上交叉打包需要 wine；macOS 产物必须在 macOS 上构建
- 未配置代码签名证书，安装包未签名
- 使用默认 Electron 图标，可自行放入 `build/icon.png` 等自行替换
- Electron 内默认使用 JSON 存储；若要在 Electron 里使用 SQLite，需要针对 Electron 的 Node ABI 重新编译 `better-sqlite3`（`npx electron-rebuild better-sqlite3`）。Electron 45 内置 Node 24，但它的 ABI（150）与普通 Node 24 不同，本机 `npm rebuild` 的产物不能直接复用

## 验证

```bash
npm run verify       # 端到端：HTTP/上传/WS 同步/多项目/SQLite/主题/旧数据迁移，200+ 断言
npm run typecheck    # 前端 TypeScript
npm run typecheck:server
npm run lint
npm run test:api     # REST v1：CRUD、revision、422、旧 API 兼容、鉴权
npm run test:mcp     # HTTP / stdio MCP 工具一致性与实际调用、管理员令牌
npm run test:mobile  # 390×844 手机布局（无 Chromium 自动 skip）
npm run test:auth    # 角色矩阵、CSRF、setup、会话吊销、Electron 模式
npm run test:theme
npm run sdk:test     # SDK 构建、单元测试与真实服务端集成测试
npm run sdk:pack     # 检查 SDK npm 包内容
npm run test:all     # 聚合 API / MCP / 主题 / 手机端 / 鉴权
```

## 数据

- 默认存储在 `data/state.json`，也可切换到 SQLite / PostgreSQL / MySQL（见上）
- 旧版单积分榜数据（`data/state.json` 里直接是 people/teams/settings）启动时自动迁移为「默认项目」
- 上传的头像保存在 `data/avatars/`，上限 2MB，仅支持 png/jpeg/webp/gif
- `DATA_DIR=/path/to/dir npm start` 可更换数据目录

## 结构

```
server/index.js   入口：http 路由、上传、导出/导入/CSV/备份/清理 API、挂载 REST v1 / MCP / WS
server/api/       REST v1：路由匹配、响应/错误、资源处理、OpenAPI 生成
server/mcp/       MCP：JSON-RPC 协议、工具派生、HTTP 与 stdio 传输
server/state.js   权威状态：多项目、applyOp 校验、防抖串行写盘、导入清洗
server/runtime.js 运行时态：撤销栈、倒计时、广播快照（仅内存）
server/storage.js 存储后端：json / sqlite / postgres / mysql
server/wss.js     WebSocket：op 分发、全量广播（含 runtime）、心跳
server/security.js 共享 Origin 校验
server/backup.js  自动备份
server/cleanup.js 孤儿上传文件清理
server/static.js  静态文件服务（防路径穿越）
bin/              CLI 入口（服务 + stdio MCP）
public/           静态资源（CSS / 图片 / 媒体）；React 构建产物在 public/v2/
web/              React + TypeScript 前端源码（admin / display）
packages/sdk/     独立 npm SDK（REST API v1 + MCP，ESM/CJS + 类型）
docs/             文档（API / MCP / 手机端 / 安全 / 主题规范）
scripts/          契约生成与测试：verify / api-v1 / mcp / mobile-ui / theme-*
Dockerfile / docker-compose.yml / deploy/screenscoreboard.service 部署
```
##

PeijunDev 用♥️开发