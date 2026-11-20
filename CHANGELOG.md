# 变更日志

本项目遵循语义化版本。1.4.0 起，版本号在管理端顶栏与启动日志中显示。

## 未发布 — 鉴权与远程部署

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
