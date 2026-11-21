# 存储后端

系统把整份状态（项目、人员、团队、设置、主题库）作为一个 JSON 快照持久化。后端可在管理端切换，也可用环境变量选择。

## 支持矩阵

| 后端 | 类型 | 依赖 | 快照位置 | CAS | 跨主机锁 |
|---|---|---|---|---|---|
| `json` | 文件 | 无 | `data/state.json` | 内容哈希 | 本地文件锁 |
| `txt` | 文件 | 无 | `data/state.txt`（缩进 JSON） | 内容哈希 | 本地文件锁 |
| `sqlite` | 文件 | `better-sqlite3`（原生） | `scoreboard_state` 表 | `revision` 列 | 本地文件锁 |
| `postgres` | 数据库 | `pg`（纯 JS） | `scoreboard_state` 表 | `revision` 列 | `pg_advisory_lock` |
| `mysql` | 数据库 | `mysql2`（纯 JS） | `scoreboard_state` 表 | `revision` 列 | `GET_LOCK` |
| `mongodb` | 数据库 | `mongodb`（纯 JS） | `scoreboard_state` 文档 | `revision` 字段 | 不支持（仅 CAS） |
| `sqlserver` | 数据库 | `mssql`/`tedious`（纯 JS） | `dbo.scoreboard_state` 表 | `revision` 列 | 不支持（仅 CAS） |
| `oracle` | 数据库 | `oracledb` Thin（纯 JS 路径） | `scoreboard_state` 表 | `revision` 列 | 不支持（仅 CAS） |
| `redis` | 数据库 | `redis`（纯 JS） | `<prefix>:state` Hash | Lua 脚本 | `SET NX PX` + 续租 |

新增驱动都在 `optionalDependencies` 中按需加载；未安装时只有选择该后端才会提示 `npm install <pkg>`，不影响其他后端。

## 配置优先级

1. `DATA_DIR/storage.json`（管理端保存）
2. 存储相关环境变量（`STORAGE`、`STATE_FILE`、`DATABASE_URL` 等）
3. 默认 `json`

`storage.json` 存在时环境变量不再决定连接目标；运行时调优变量（重试、超时、锁 TTL 等）仍然生效。

### storage.json

```json
{
  "version": 1,
  "kind": "postgres",
  "options": {
    "host": "db",
    "port": 5432,
    "user": "scoreboard",
    "password": "secret",
    "database": "scoreboard"
  },
  "updatedAt": "2026-11-22T00:00:00.000Z",
  "updatedBy": "admin"
}
```

- 文件权限 `0600`；仅管理员 API 可读，密码不回传前端。
- 文件损坏、版本不支持或字段非法时服务**拒绝启动**（fail-closed）。修复该文件，或移走它回退到环境变量/默认 JSON。
- 文件类后端的 `file` 必须是 `DATA_DIR` 内的相对路径；拒绝绝对路径、`..`、符号链接、保留文件与错误扩展名。

## 管理端操作

入口：管理端顶栏「存储后端」（移动端在「更多 → 控制台」）。

1. **测试连接**：只读探测，返回延迟、目标是否已有数据、Redis AOF/淘汰策略警告，不写配置。
2. **仅保存配置**：写入 `storage.json`，不迁移数据；重启后新后端按自身现有数据启动。
3. **保存并迁移现有数据**：把当前状态写入目标后端，回读并做内容哈希校验，成功后才保存配置。
4. **保存并切换为空库**：目标已有数据时需要勾选「目标已有数据时覆盖」。

保存或迁移后必须**重启服务**才会生效。迁移写的是保存时刻的快照；到重启前对旧后端的写入不会同步到新后端，请尽快重启。

## 迁移与回滚

- 迁移前先 `flushSave()`，确保旧后端已落盘。
- 目标已有数据且未确认覆盖时返回 `409`。
- 迁移写入后回读，比较规范化 JSON 的 SHA-256；不一致则回滚（目标原为空则删除本次写入，目标原非空则用迁移前快照恢复）。
- 只有校验通过才写 `storage.json`；任何失败都不会切换运行中的后端。
- 应用层迁移上限默认 64MB（`STORAGE_MIGRATION_MAX_BYTES`）；MongoDB 额外限制为 15.5MB。

## 版本号与乐观并发（CAS）

- SQL/Mongo/Redis 使用整数 `revision`，首次写入为 1，每次成功写入 +1。
- JSON/TXT 使用文件内容的 SHA-256 作为 revision。
- 保存时带上期望 revision；不一致抛出冲突，服务**停止落盘并降级健康状态**，不覆盖新数据。请重启或检查是否有另一个实例写同一后端。
- 旧表在启动时自动补 `revision` 列，并把旧行初始化为 1。

## 分布式锁

- PostgreSQL：会话级 `pg_advisory_lock`（专用连接）。
- MySQL：`GET_LOCK` / `RELEASE_LOCK`（专用连接）。
- Redis：`SET lock NX PX` + 定时续租 + Lua 校验后释放。
- 本地 `DATA_DIR/scoreboard.lock` 始终保留，保护账号文件、上传资产与同机双实例。
- 锁只保证**单写者**，不提供 active-active 多副本；MongoDB/SQL Server/Oracle 本期仅靠 CAS。
- `ALLOW_MULTI_INSTANCE=1` 会跳过本地锁和分布式锁，仅用于调试。

## Redis 注意事项

Redis 作为权威存储时：

```conf
appendonly yes
appendfsync everysec   # 更严格可用 always
maxmemory-policy noeviction
```

- 默认 RDB 快照可能丢失最近写入；开启淘汰会直接丢状态。
- 健康检查会读取 `INFO persistence` 与 `CONFIG GET maxmemory-policy` 并给出警告；ACL 禁止 `CONFIG` 时降级为未知，不判失败。
- 仅支持 standalone；Cluster/Sentinel 本期未适配。

## MongoDB 注意事项

- 整份状态存为单个文档，上限 16MB。大项目 + 主题库可能接近上限；迁移会明确失败。
- 暂不支持跨主机锁，请单实例运行。

## 驱动与打包

- `better-sqlite3` 是原生模块：切换 Node 大版本后执行 `npm rebuild better-sqlite3`；Electron 中需 `npx electron-rebuild better-sqlite3`。
- `mongodb`、`mssql`、`redis` 为纯 JS。
- `oracledb` 使用 Thin 模式，不需要 Instant Client；包体积较大，Alpine 上若无预编译包可能跳过安装，不影响其他后端。
- Alpine 镜像构建会现场编译 `better-sqlite3`（musl 无预编译包）。

## 健康检查

- 公共 `GET /api/health`：`storage`（后端类型）与 `storageOk`（无冲突），不泄露连接信息。
- 管理员 `GET /api/v1/storage/health`：revision、延迟、最近写入、锁状态、冲突与警告；`?refresh=1` 强制探测，否则缓存 10 秒。

## 故障排查

| 现象 | 处理 |
|---|---|
| 启动报「存储配置文件损坏」 | 修复或移走 `DATA_DIR/storage.json`，回退到环境变量/默认 JSON |
| 启动报「不支持的存储后端」 | 检查 `kind`/`STORAGE` 拼写；可用值见上表 |
| 启动报驱动缺失 | 按提示 `npm install <pkg>`，或改回文件后端 |
| 迁移 409 | 目标已有数据；勾选覆盖，或改用空库启动 |
| 健康检查 `conflict: true` | 检测到外部写入，已停止落盘；重启或排查第二个实例 |
| Redis 警告 AOF 未开启 | 按上文开启 AOF 与 noeviction |
| MongoDB 迁移失败 | 快照超过 16MB，改用 PostgreSQL 等关系型后端 |
| SQLite ABI 错误 | `npm rebuild better-sqlite3`；Electron 用 `electron-rebuild` |
| MySQL 报包过大 | 提高 `max_allowed_packet`，或改用 PostgreSQL |

## 测试

```bash
npm run test:storage
TEST_PG_URL=postgres://... TEST_MYSQL_URL=mysql://... \
TEST_MONGO_URL=mongodb://... TEST_REDIS_URL=redis://... \
  npm run test:storage
```

SQL Server / Oracle 可通过 `TEST_MSSQL_URL`、`TEST_ORACLE_URL` 在具备实例时运行。
