# 变更日志

本项目遵循语义化版本。1.4.0 起，版本号在管理端顶栏与启动日志中显示。

## 未发布 — 容器、Dev Container 与 Kubernetes

### 新增

- **Dev Container**：`.devcontainer/devcontainer.json` 提供 Node 24 开发环境，自动 `npm ci`，转发 3000 / 5173。
- **Kubernetes**：`deploy/k8s/` 提供 Kustomize 清单（Namespace、ConfigMap、Secret 示例、PVC、单副本 Deployment、Service、Traefik Ingress），默认按 k3s 编写，并附带从零安装、镜像导入、升级、备份与排错的完整说明。
- **Podman Quadlet**：`deploy/quadlet/screenscoreboard.container` 作为 systemd 用户服务长期运行。
- **镜像发布**：新增 GitHub Actions 工作流，Release 时推送 `ghcr.io/peijundev/screenscoreboard:<版本>` 与 `:latest`。
- **容器文档**：新增 `docs/containers.md`，覆盖 Docker、Docker Rootless、Podman、Dev Container 与 K8s。
- **Electron 缩放**：显示端与管理端支持浏览器式页面缩放（`Ctrl/Cmd + 滚轮`、`+`、`-`、`0`），范围 50%–300%、每档 10%；比例只存在于当前窗口，不写入配置，关闭窗口或重启后回到 100%。
- **WebStorm 调试**：前端调试配置自动拉起 Vite；后端调试改用独立 `data/debug`；补齐认证/SDK/契约/格式化/密码重置/通用打包配置；新增 Electron 主进程与渲染进程 Attach、测试子进程 Attach、SourceMap 构建配置；新增 `http/` HTTP Client 集合（REST API v1 + MCP）；Dev Container 声明 JetBrains 后端并转发调试端口。
- **可切换存储后端**：管理端新增「存储后端」对话框，可可视化选择后端、填写连接参数、测试连接、迁移现有数据或空库切换，保存后重启生效。
- **新增后端**：TXT（人类可读缩进 JSON）、MongoDB、SQL Server、Oracle（Thin 模式）、Redis；驱动均按需加载，未安装时只影响所选后端。
- **存储配置**：`DATA_DIR/storage.json`（权限 0600，仅管理员 API 可读，密码不回传），优先于存储相关环境变量；文件损坏时拒绝启动。
- **可靠性与并发**：连接超时/重试、健康诊断（`/api/v1/storage/health`）、`revision` 乐观并发（CAS）、PostgreSQL advisory lock / MySQL `GET_LOCK` / Redis 分布式锁。
- **测试**：新增 `npm run test:storage`；CI 增加 MongoDB 7 与 Redis 7 service；`npm run verify` 覆盖配置 API、TXT 迁移、密码不回传、非法配置与损坏配置。
- **管理端主题**：在原有 KDE Breeze 深/浅之外新增 GNOME Adwaita 与 macOS 各深/浅，共六套；桌面顶栏与移动端「更多 → 显示」均可切换，选择保存在浏览器 localStorage，旧值 `dark`/`light` 自动兼容；Adwaita 使用 8px 圆角与 GNOME 蓝，macOS 使用系统蓝、6px 控件圆角与系统字体优先。

### 变更

- 运行镜像从 Debian slim 改为 **Alpine**，最终镜像约 200 MB；`better-sqlite3` 在构建阶段现场编译 musl 版本，构建工具不进入运行镜像。
- `docker-compose.yml` 增加健康检查、只读根文件系统、`no-new-privileges`、PostgreSQL profile；新增 `docker-compose.rootless.yml` 解决 rootless 下 bind mount 权限问题。
- 存储后端由 4 种扩展到 9 种；`scripts/gen-contracts.mjs` 改为直接读取 `server/settings.js`，不再通过 `state.js` 间接初始化存储，配置损坏不会阻断契约生成。
- 旧 SQL 表在启动时自动补 `revision` 列并把旧行初始化为 1，无需手工迁移。
- 存储保存改为 CAS：检测到外部写入时停止落盘并降级健康状态，避免旧快照覆盖新数据。

## 1.6.3 — Node.js 24 基线

### 破坏性变更

- **最低 Node.js 版本提升到 24**：根包与 `@peijundev/screenscoreboard-sdk` 的 `engines.node` 均为 `">=24"`，不再声明支持 Node 20 / 22。
- 升级后需要重新安装依赖，并用 Node 24 重新编译原生模块（`npm rebuild better-sqlite3`）；旧版本编译的 `better-sqlite3` 不能继续使用。
- `@types/node` 对齐到 24.x，类型声明不再高于运行时版本。

### 改进

- `npm run test:theme` 依赖 Node 24 的原生 TypeScript 类型剥离（直接加载 `.ts` 源码），现已纳入 CI 与 Release Checks。
- CI / Release 的 Node 版本改为读取 `.nvmrc`，与本地开发单一来源。
- Dockerfile 支持 `--build-arg NODE_VERSION=24.22.1` 固定 Node 小版本，默认仍为 24。
- 修复 Docker 前端构建阶段：Vite 8 的 rolldown 原生绑定是可选依赖，原 `npm ci --omit=optional` 会报 `Cannot find module '@rolldown/binding-linux-x64-gnu'`；改为 `npm ci --ignore-scripts`，同时避免下载 Electron 与编译 better-sqlite3。
- README 与鉴权文档补充 Node 24+ 要求；Electron 45 内置 Node 24，但 ABI 与普通 Node 不同，SQLite 仍需 `npx electron-rebuild better-sqlite3`。

## 1.6.2 — Electron 三模式

### 改进

- **Electron 启动页拆分为三个入口**：本地模式、远程管理模式、远程屏幕模式。
  - 远程管理模式只填写三项：远程服务器根地址、账号、密码；显示端窗口默认使用服务器地址 + `/display`。
  - 远程屏幕模式只填写一项完整显示端网址，不需要登录，直接以无标签页浏览器打开；支持任意 http/https 页面。
  - 旧配置 `mode: "remote"` 自动迁移为远程管理模式；`SCOREBOARD_MODE=remote` 同样兼容。
  - 远程屏幕模式可通过菜单「服务器 → 退出到欢迎页（切换模式）」返回欢迎页。

## 1.6.1 — 纯突显、SDK 与访问控制

### 新增

- **纯突显（不加分）**：新增 `triggerSpotlight` op，可通过管理端人员 / 团队行的「突显」按钮、WebSocket op、`POST /api/v1/projects/:projectId/spotlight` 或 MCP 工具 `trigger_spotlight` 凭空触发「居中放大突显」，不改变分数、不写撤销栈与分数日志
- 复用既有突显参数（主题、范围、宽高、播放模式、压暗等）；新增 `featureSpotlightTrigger` 开关与 `spotlightTriggerDuration` 时长（0=跟随主题）；单次 API 调用可用 `durationMs` 覆盖
- 运行时新增 `spotlightEvents`（按项目、递增 `seq`），显示端只在检测到新事件时播放，重连/刷新不会补播历史突显
- **访问控制 / 开放模式**：部署模式下管理员可在「账号与安全 → 访问控制」关闭登录系统，所有 HTTP/WS/MCP 请求自动获得管理员权限（等同于旧版完全开放）；设置持久化到 `auth.json` 的 `settings.requireLogin`，要求至少保留一个启用中的管理员；重新启用登录时开放模式建立的 WS 连接立即失效
- 新增 `GET/PATCH /api/v1/auth/access`；`/api/v1/auth/status` 增加 `openAccess` / `requireLogin`；管理端顶栏显示「开放模式 · 管理员」并隐藏退出按钮
- **官方 SDK**：新增独立 npm 包 `@peijundev/screenscoreboard-sdk`（`packages/sdk`），同时封装 REST API v1 与 MCP；支持 API 令牌、账号密码会话、CSRF、401 自动重登、超时/取消、统一错误类型，ESM + CommonJS 双格式、零运行时依赖；覆盖项目/人员/团队/分数/手动突显/设置/运行态/主题/草稿/资源库/备份与访问控制，并提供 `client.request()` 通用通道
- SDK 文档与 AI 接入示例见 [packages/sdk/README.md](packages/sdk/README.md)；CI 增加 SDK 构建与单元/集成测试

## 1.6.0 — 鉴权与远程部署

### 新增

- **完整多用户鉴权**：`admin` / `operator` / `viewer`，账号密码（scrypt）、HttpOnly 会话 Cookie、CSRF 双提交、会话持久化、逐个吊销、最后一个管理员保护
- **API 令牌**：`Authorization: Bearer`，只存 SHA-256，可随时吊销；HTTP MCP 与 stdio MCP（`SCOREBOARD_TOKEN`）均支持
- **初始化**：`ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE`，或仅 loopback 的首次网页初始化；公网/反代请求被拒绝
- **服务端强制**：`applyOp` actor 校验、REST route 权限、旧 `/api/*` 集中守卫、WS 按 op 鉴权、MCP 进程内调用继承同一身份
- **显示端公开只读**：匿名可收快照；`?edit=1` 布局编辑仅管理员登录后可用
- **HTTPS**：反代（Caddy/Nginx）与 Node 内置 HTTPS（`TLS_CERT_FILE` / `TLS_KEY_FILE`），`TRUST_PROXY`、`X-Forwarded-*`、Secure Cookie
- **Electron 双模式**：启动时先选择本地/远程；本地模式内嵌服务端并关闭鉴权（仅 loopback）；远程模式填写服务器根地址 + 账号 + 密码登录，显示端填写完整网址并按无标签页浏览器加载；不保存密码；运行中可通过管理端「切换模式」按钮或菜单回到欢迎页重新选择
- `npm run auth:reset`：停止服务后本机重置密码/补建管理员；Docker/systemd 文档已补齐
- 新文档：[docs/authentication.md](docs/authentication.md)

### 安全

- 明确**不做任何 WS/HTTP 限流**：无失败计数、锁定、退避、验证码或 429；现有 body/连接数/背压属于容量保护
- 鉴权数据独立存于 `DATA_DIR/auth.json` 与 `sessions.json`（0600），不进入 state 快照、导出或项目备份
- 匿名显示端快照仍包含全部项目，属于公开显示端的既有语义

### 兼容性

- 升级后管理端需要登录；脚本/MCP 需要先登录或配置 API 令牌
- 首次启动若未设置 `ADMIN_PASSWORD`，只允许本机完成初始化
- 多实例部署的用户/会话不共享，本期按单实例设计

## 1.5.2 — 完整 API、MCP 与手机管理端

### 新增

- **REST API v1（`/api/v1`）**：92 条端点覆盖项目、人员、团队、分数、设置、运行态、主题库、主题子资源、主题草稿、导入导出、上传、备份与低层 `op`；全部写操作经 `applyOp` 落库并广播 WebSocket；动态生成 OpenAPI 3.1（`GET /api/v1/openapi.json`）
- **MCP**：`POST /mcp`（HTTP）与 `bin/screenscoreboard-mcp.js`（stdio）两种传输，共用 87 个由路由表派生的工具与 5 个只读 resource；协议版本 `2025-06-18`
- **手机管理端**：≤860px 自动切换底部标签布局（预览 / 人员 / 团队 / 主题 / 更多），保留全部功能；对话框全屏 + 安全区，应用内 `prompt/confirm`，触控目标可调，预览平移模式与矢量约束开关不再依赖键鼠
- **新增设置**：`featureMobileAdmin`（默认开，回滚开关）、`adminTouchTargetSize`（40–64，默认 44）
- **新增 op**：`updatePerson`、`updateTeam`
- 文档：[docs/api-v1.md](docs/api-v1.md)、[docs/mcp.md](docs/mcp.md)、[docs/mobile-admin.md](docs/mobile-admin.md)、[docs/security-notes.md](docs/security-notes.md)
- 测试脚本：`test:api`、`test:mcp`、`test:mobile`、`test:all`

### 安全

- 本期不实现鉴权，`/api/v1` 与 `/mcp` 仅适合可信局域网；REST 入口预留 `authorize()` 钩子，远程化时再补 Token、授权、限流、CSP 与审计

### 恢复 / 默认

- 恢复内置显示风格「真·古风」（`xianxia`）及四色卷轴卡面素材；旧项目和旧导出文件中的该风格不再回落
- 默认显示风格改为「古风雅集」（`guofeng`）；已有项目保存过的风格保持不变

### 前端

- 主题工作室矢量子编辑器修复「圆」工具实际创建圆角矩形的问题；矩形/圆/线/文字改为拖动绘制，Shift 约束正方形/正圆/45° 线段，单击仍按默认尺寸创建
- 线段节点支持有符号宽高以表达任意方向，选择框、缩放与命中区域按包围盒归一化
- 快照稳定化 + React.memo，未变化的卡片不再重渲染；首字头像缓存
- 设置未变化时跳过整页外观写入
- 卡片超过 300 张时自动关闭 FLIP 排序动画，优先帧率
- 大状态自动放宽广播合并窗口（默认 250ms）
- 2000 人实测：大屏约 10 → 60 FPS，管理端约 8 → 39 FPS

### 后端

- 合并 WebSocket 广播（默认 50ms）、背压与连接数上限；显式启用 permessage-deflate
- JSON 存盘改为异步原子写并默认 compact；上传/备份异步化
- `nextOrder` 缓存、`movePerson/moveTeam` 改为 O(n) 邻接查找
- 未捕获异常保护、优雅退出（关闭 WS/HTTP 后落盘）、非法 URL 编码安全处理
- 新增 `GET /api/health`；Docker HEALTHCHECK 切换；基础安全响应头；`HOST` 可配置（Electron 绑 127.0.0.1）
- WebSocket Origin 校验
- 单实例锁（同 `DATA_DIR` 拒绝第二实例）与 SQLite `busy_timeout`
- 拆分 `state.js`（settings / validation / 核心状态），缩小单文件体量
- 设置/op 契约生成（`npm run gen:contracts`）；`npm run typecheck:server` 覆盖全部后端；ESLint/Prettier；CI 增加 lint/typecheck/verify（含 Postgres/MySQL）
- 文档：`docs/backend-optimization.md`

## 1.5.0 — React UI 技术栈

> **1.4.0 已封存。** 自 1.5.0 起前端全面切换到 React；后端（Node 原生 http + WebSocket）、WS 协议与 `data/` 数据格式保持不变。

### 技术栈

- 前端：React 19 + Vite + TypeScript + Zustand；源码在 `web/`，构建产物在 `public/v2/`
- `/admin`、`/display` 由 React 提供；`npm start`、`npm run electron`、`npm run dist*` 会自动先构建前端
- Docker 增加前端构建阶段；npm 发布前自动构建
- 旧版原生 JS 前端与 `/admin-legacy`、`/display-legacy` 已移除；未构建时返回 503 并提示 `npm run build:web`
- 管理端顶栏显示 `v1.5.0 · React`

### 新增

- **简介**（原「座右铭」）：人员/团队可设置最多 60 字的简介，显示在人员卡、团队卡与成员小卡；支持整体开关，以及字体、字号、颜色、不透明度、斜体独立调节
- **主题编辑器**：管理端新增「主题编辑器」，选择基础风格并调整颜色、字体、卡片、背景、倒计时等视觉设置，实时预览；支持导入 / 导出 `.theme.json`
- **主题导入 / 导出**：主题为视觉设置的 JSON 快照；服务端严格校验格式、基础风格与 79 个允许键，非法键或值整份拒绝
- **主题规范**：[docs/theme-spec.md](docs/theme-spec.md)
- **排版设置拆分**：按「版式 / 外观 / 字体 / 特效」分为 4 个标签页

### 移除

- 内置主题「真·古风」（`xianxia`）及其卡面素材；旧项目加载时自动回落为 `lecture`，旧导出文件导入时同样自动转换

### 修复

- 修复「按分数从高到低」时大屏卡片实际按分数从低到高排列的问题（React 版排序逻辑）

### 兼容性

- `data/` 目录、存储后端、WS 协议与 1.4.0 完全兼容，可直接升级
- Node 版本要求提升到 20.19+（Vite 构建要求），推荐使用 `.nvmrc` 的 24
- 如果绕过 npm 脚本直接运行 `node server/index.js`，需先执行一次 `npm run build:web`

## 1.4.0 — 原技术栈的最后一个版本（已封存）

> 本版本是原技术栈（Node 原生 http + WebSocket、零构建、原生 DOM 前端）的**最终版本，已封存，不再更新**。
> 1.5.0 起前端已迁移到 React UI 技术栈，见上方章节。

### 新增

- **人员 / 团队调顺序**：列表内 ↑↓ 按钮调整顺序，首次调序自动切换到「自定义顺序」，大屏按该顺序展示；排序方式新增「自定义顺序」（`sortBy: manual`）
- **人员 / 团队改名**：点击姓名或团队名即可修改，实时同步到大屏、排行榜与 CSV 导出
- **标题字体**：标题可独立于正文字体选择字体（预设 / 自定义系统字体）
- **字体全面可调**：标题、时钟、倒计时、排行榜、跑马灯、欢迎幕布、分数数字都能单独换字体；时钟、倒计时（含角落小窗）、欢迎幕布新增字号调节
- **背景图虚化**：新增「背景图虚化」开关与虚化度（0–40px），所有主题通用，仅虚化背景图、不影响卡片与文字
- **管理端浅色 / 深色切换**：右上角「主题」按钮，偏好存本地，多标签页同步
- **新显示风格「真·古风」**：宣纸底 + 远山云雾、行楷标题与金色云纹标题线；卡片强制使用内置卷轴卡面（棕金 / 樱粉 / 竹青 / 朱红四色轮换），该主题下卡片样式与记分特效一律禁用
- **倒计时主题**：新增「水墨（静态画面）」与「水墨影片（原片）」，影片模式倍速自适应、与倒计时同时结束
- **版本标识**：管理端顶栏显示版本号，1.4.0 标记为「最终版」；新增 `GET /api/version`

### 环境说明

- SQLite 后端依赖原生模块 `better-sqlite3`。切换 Node 大版本后若启动报 ABI 不一致，执行 `npm rebuild better-sqlite3` 即可

### 已知问题

- 「按分数从高到低」排序时，大屏卡片实际按分数从低到高排列（排序方向处理有误），待 1.4.x 修复

### 兼容性

- 配置文件、存储后端、`data/` 目录结构均未改变，可直接覆盖升级
- 旧数据（含 v1 单积分榜）启动时自动迁移并补齐排序序号
- 自定义顺序 / 改名 / 字体 / 虚化等新设置均有默认值，未设置时行为与 1.3.0 一致

## 1.3.0

- 上一稳定版本。

## 1.1.0

- 早期版本。
