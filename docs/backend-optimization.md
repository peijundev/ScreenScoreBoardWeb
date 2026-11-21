# 后端技术栈优化记录

后端保持 **Node 原生 http + ws**，不做框架迁移；按阶段渐进优化。

## 已实施：Phase 1（性能 / 健壮性 / 观测）

### 1. 配置与日志

- `server/config.js`：环境变量集中解析（HOST、广播、WS 限制、日志、落盘格式等）。
- `server/logger.js`：零依赖结构化日志，支持 `text` / `json`、`child` 字段与敏感字段脱敏。
- 启动、保存失败、WS 异常、慢 op（默认 >100ms）均有日志。

### 2. 持久化

- JSON 后端改为 `fs.promises` 异步原子写（tmp + rename），不再阻塞事件循环。
- 默认 compact JSON（可用 `STATE_FILE_PRETTY=1` 恢复缩进）。
- 启动时清理上次崩溃遗留的 `state.json.tmp`。
- 上传头像/音效改为异步写盘，并对写盘失败返回 500。
- 自动备份改为异步写 + 防重叠执行。

### 3. WebSocket

- **合并广播**：默认 50ms 窗口内的多次变更只序列化/发送一次（`BROADCAST_COALESCE_MS=0` 可回退）。
- **背压**：单连接 `bufferedAmount` 超过 1MB 时跳过本轮，避免慢客户端导致内存膨胀。
- **连接上限**：默认 200（超限关闭，close code 1013）。
- **压缩**：显式启用 permessage-deflate（阈值 1KB）。
- ack 仍立即返回，前端 `sendOp` 的 Promise 结算不受合并影响。
- 心跳 interval 已 `unref`；ws/wss 均注册 error 监听；send 均做异常保护。

### 4. 状态操作

- `nextOrder` 增加非枚举缓存，新增人员/团队不再每次遍历全部实体。
- `movePerson` / `moveTeam` 改为 O(n) 邻接查找 + 交换 order，不再每次排序 + `indexOf`。

### 5. 健壮性与退出

- `uncaughtException` / `unhandledRejection` 记录并退出（交给 systemd / Docker 重启）。
- `decodeURIComponent` 非法编码返回 400，不再可能触发未捕获异常。
- 优雅退出：先关闭 WS 与 HTTP（`closeAllConnections`），再落盘（超时 10s，超时会记录日志），最后关闭存储。
- 落盘前有初始化保护，避免早期崩溃覆盖已有数据。

### 6. 观测与安全

- 新增 `GET /api/health`（版本 / uptime / 存储 / WS 连接数 / 项目数，响应 <1KB）。
- Docker HEALTHCHECK 从全量 `/api/state` 切换为 `/api/health`。
- 基础安全响应头：`nosniff`、`SAMEORIGIN`、`no-referrer`。
- `HOST` 可配置；Electron 内嵌服务固定绑定 `127.0.0.1`。

### 实测结果（Node 24）

| 项目 | 结果 |
|---|---|
| 连续添加 2000 人 | 17ms（约 0.009ms/op，含 order 缓存） |
| `movePerson`（2000 人） | 约 0.54ms/op（原排序实现约 0.61ms） |
| 5 次连续记分的广播数 | <5（合并生效；自动化测试覆盖） |
| JSON 存盘 | 默认 compact，无同步写阻塞 |
| SIGTERM 立即退出 | 最后一条 op 已落盘，无 `.tmp` 残留 |
| `WS_MAX_CONNECTIONS=1` | 第二个连接被正常关闭 |
| `HOST=127.0.0.1` | 仅监听回环 |

## 前端渲染性能（2026-11）

- **快照稳定化**：WS 全量快照到达后，未变化的项目/人员/团队/设置复用旧引用，配合 `React.memo` 跳过未变化卡片。
- **首字头像缓存**：同一姓名/尺寸只生成一次 SVG data URI。
- **外观写入去重**：设置对象未变化时跳过整页 CSS 变量/主题写入。
- **FLIP 阈值**：卡片数 > 300 时自动跳过逐卡读取布局的排序动画，避免拖垮帧率。
- **大状态广播合并**：状态 >150KB 时合并窗口自动放宽到 250ms。
- **布局隔离**：卡片/管理端行使用 `contain: layout style`。

实测（2000 人、headless Chromium，连续 20 次记分）：

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 2000 张独立卡片 | ~10 FPS，长任务 3.7s | **约 55–60 FPS**，长任务约 0.3–0.4s |
| 20 团队 / 2000 成员 | — | **~73 FPS**，无长任务 |
| 管理端 2000 人（含预览） | ~8 FPS | **约 20–40 FPS**（受预览 iframe 影响） |

## Phase 2（可维护性 / 契约）— 已完成核心部分

- ✅ 契约单一来源：`server/ops.js`（当前 42 个 op）+ `server/state.js` 的 `DEFAULT_SETTINGS`→ `scripts/gen-contracts.mjs` 生成 `web/src/shared/{settings,ops}.generated.ts`；前端 `SendOp`/`Ctx.op` 使用 `OpName`，设置字段获得完整类型。
- ✅ `tsconfig.server.json`（`allowJs + checkJs`）覆盖全部 `server/*.js`，`npm run typecheck:server` 零错误（零构建，Electron 路径不变）。
- ✅ CI 新增 `.github/workflows/ci.yml`：前端/后端 typecheck、生成文件一致性、`npm run verify`；Release 构建增加 `checks` 门禁。
- ✅ 拆分 `server/state.js`：抽出 `server/validation.js`（通用校验）与 `server/settings.js`（默认值/主题白名单/逐项校验）；`state.js` 从 1,335 行降到约 790 行，导出路径不变。
- ✅ ESLint（flat config）+ Prettier 配置；`npm run lint` 零问题；`npm run format` 可用。
- ✅ 补测 `resetLayout`、WS Origin/超限、单实例锁；新增 Postgres/MySQL 存储往返测试（`TEST_PG_URL` / `TEST_MYSQL_URL`，CI 用 service container 执行）。
- ⏳ 未做：真正 `.ts` 编译产物（当前为 checkJs + JSDoc，零构建）。

## Phase 3（安全）— 已完成基础部分

- ✅ WebSocket Origin 校验：同源放行，跨站拒绝（`ALLOWED_ORIGINS` 可追加）。
- ✅ `HOST` 可配置；Electron 内嵌服务固定 `127.0.0.1`；基础安全响应头。
- ✅ 账号/角色/会话/API 令牌鉴权、CSRF、HTTPS（反代或 Node 内置）、HSTS（HTTPS 下）。
- ⏳ 按使用场景明确不做：HTTP/WS 限流。
- ⏳ 未做：完整审计、严格 CSP。

## Phase 4（多实例）— 已完成单写者保护与乐观并发

- ✅ 单实例锁：`DATA_DIR/scoreboard.lock`（含 PID 与启动时间），第二个实例明确报错退出；进程已退出的陈旧锁自动清理；`ALLOW_MULTI_INSTANCE=1` 可强制绕过（仅调试）。
- ✅ SQLite `busy_timeout = 5000`。
- ✅ 跨主机单写者：PostgreSQL advisory lock、MySQL `GET_LOCK`、Redis `SET NX PX` + 续租。
- ✅ 版本号 + CAS：SQL/Mongo/Redis 使用整数 `revision`，JSON/TXT 使用内容哈希；旧表启动时自动补列。冲突时停止落盘并要求重启，不覆盖新数据。
- ✅ 存储后端扩展：TXT、MongoDB、SQL Server、Oracle（Thin）、Redis；管理端可视化配置、测试连接、迁移/空库切换。详见 `docs/storage-backends.md`。
- ⏳ 未做：MongoDB/SQL Server/Oracle 的跨主机锁、Redis Cluster/Sentinel、active-active 多副本、差分订阅协议。

## Phase 5（完整 API / MCP）— 已完成

- ✅ REST v1 `/api/v1`：92 条路由，全部写操作经 `commit()` → `applyOp` → `save()` → `broadcastState()`，禁止直接改 state；旧 `/api/*` 与 `/ws` 保持不变。
- ✅ 错误分层：`NotFoundError` / `FeatureDisabledError` 继承 `OpError`，精确映射 404/403，同时保持旧 `instanceof OpError` 兼容。
- ✅ 主题子资源乐观并发：`If-Match` 或 `?revision=`，缺失 428、冲突 409、成功返回新 revision；草稿 revision 自增。
- ✅ OpenAPI 3.1 由路由表动态生成，避免文档与实现漂移。
- ✅ MCP：手写 JSON-RPC 2.0（`initialize` / `ping` / `tools/list` / `tools/call` / `resources/*`），HTTP `POST /mcp` 与 stdio 共用路由派生工具；stdio 作为 REST 客户端连接已运行服务，不启动第二实例、不碰单实例锁。
- ✅ 测试：`scripts/api-v1.test.mjs`（CRUD、revision、422、WS 广播、旧 API 兼容）、`scripts/mcp.test.mjs`（HTTP/stdio 工具表一致、实际调用、resources）、`scripts/mobile-ui.test.mjs`（CDP 390×844）。
- ✅ 鉴权/授权已补齐；⏳ 限流/审计/CSP 仍不做/未做，见 `docs/security-notes.md`。

## 明确不做

迁移 Express/Fastify、全量 TypeScript 重写、Redis 微服务/缓存层、替换序列化协议、增量日志存储 —— 当前规模下收益/风险比不划算。

> 说明：Redis **可作为存储后端**（见 `docs/storage-backends.md`），这与「不做 Redis 微服务/缓存层」不冲突；作为权威存储时必须开启 AOF 与 noeviction。
