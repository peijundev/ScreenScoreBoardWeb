# 存储后端

系统把整份状态（项目、人员、团队、设置、主题库）作为一个 JSON 快照持久化。后端可在管理端切换，也可用环境变量选择。

## 支持矩阵

| 后端 | 类型 | 依赖 | 快照位置 | CAS | 跨主机锁 |
|---|---|---|---|---|---|
| `json` | 文件 | 无 | `data/state.json` | 内容哈希 | 本地文件锁 |
| `txt` | 文件 | 无 | `data/state.txt`（缩进 JSON） | 内容哈希 | 本地文件锁 |
| `sqlite` | 文件 | `node:sqlite`（Node/Electron 内置）；旧环境回退 `better-sqlite3` | `scoreboard_state` 表 | `revision` 列 | 本地文件锁 |
| `postgres` | 数据库 | `pg`（纯 JS） | `scoreboard_state` 表 | `revision` 列 | `pg_advisory_lock` |
| `mysql` | 数据库 | `mysql2`（纯 JS） | `scoreboard_state` 表 | `revision` 列 | `GET_LOCK` |
| `mongodb` | 数据库 | `mongodb`（纯 JS） | `scoreboard_state` 文档 | `revision` 字段 | 不支持（仅 CAS） |
| `sqlserver` | 数据库 | `mssql`/`tedious`（纯 JS） | `dbo.scoreboard_state` 表 | `revision` 列 | 不支持（仅 CAS） |
| `oracle` | 数据库 | `oracledb` Thin（纯 JS 路径） | `scoreboard_state` 表 | `revision` 列 | 不支持（仅 CAS） |
| `redis` | 数据库 | `redis`（纯 JS） | `<prefix>:state` Hash | Lua 脚本 | `SET NX PX` + 续租 |
| `libsql` | 数据库 | `@libsql/client`（远程纯 JS；本地 `file:` 含原生包） | `scoreboard_state` 表 | `revision` 列 | 不支持（仅 CAS） |
| `couchdb` | 数据库 | 无（全局 `fetch`） | `_id=state` 文档 | 文档 `_rev` + `revision` 字段 | 不支持（仅 CAS） |
| `d1` | 数据库 | 无（全局 `fetch`，Cloudflare REST API） | `scoreboard_state` 表 | `revision` 列 | 不支持（仅 CAS） |
| `dynamodb` | 数据库 | `@aws-sdk/client-dynamodb`（纯 JS） | `<table>` 单项 | `revision` 属性 + 条件写 | 不支持（仅 CAS） |
| `firestore` | 数据库 | `@google-cloud/firestore`（纯 JS） | `scoreboard_state/state` 文档 | 事务内 `revision` 检查 | 不支持（仅 CAS） |
| `s3` | 对象存储 | `@aws-sdk/client-s3`（纯 JS） | `<prefix>/state.json` 对象 | ETag 条件写 | 不支持（仅 CAS） |
| `etcd` | 数据库 | 无（etcd v3 HTTP/JSON gateway） | `<prefix>/state` key | key `version` 事务比较 | 不支持（仅 CAS） |
| `lmdb` | 文件 | `lmdb`（原生 N-API） | `DATA_DIR/<目录>` 中的 `state` key | 写事务内 `revision` 检查 | 本地文件锁 |

新增驱动都在 `optionalDependencies` 中按需加载；未安装时只有选择该后端才会提示 `npm install <pkg>`，不影响其他后端。

协议兼容服务复用现有后端，不新增 kind：

- MariaDB（别名 `mariadb`）、TiDB、PlanetScale/Vitess、Aurora/RDS/Cloud SQL/Azure Database for MySQL → `mysql`。
- CockroachDB、YugabyteDB、Aurora/RDS/Cloud SQL/Azure Database for PostgreSQL、Neon、Supabase → `postgres`。
- Amazon DocumentDB、Azure Cosmos DB (Mongo API) → `mongodb`。
- Upstash、Vercel KV、ElastiCache、MemoryDB、Azure Cache、Memorystore → `redis`。
- CockroachDB、YugabyteDB、PlanetScale、Vitess 不支持会话锁，请在「跨主机锁」选择「禁用」。

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
- 应用层迁移上限默认 64MB（`STORAGE_MIGRATION_MAX_BYTES`）；按后端另有硬上限：MongoDB 15.5MB、CouchDB 7.5MB、Cloudflare D1 1.9MB、DynamoDB 380KB、Firestore 0.9MB、etcd 1.4MB。
- 运行中保存同样会预检快照大小；超过后端上限时停止落盘并记录 `SNAPSHOT_TOO_LARGE`，不会反复自动重试。

## 版本号与乐观并发（CAS）

- SQL/libSQL/Mongo/Redis/CouchDB 使用整数 `revision`，首次写入为 1，每次成功写入 +1。
- JSON/TXT 使用文件内容的 SHA-256 作为 revision。
- CouchDB 另用文档 `_rev` 做原子条件写；`revision` 字段与外部 CAS 语义对齐。
- 保存时带上期望 revision；不一致抛出冲突，服务**停止落盘并降级健康状态**，不覆盖新数据。请重启或检查是否有另一个实例写同一后端。
- 旧表在启动时自动补 `revision` 列，并把旧行初始化为 1。

## 高级选项：分块 / 分片 / 块索引

支持后端：SQLite、PostgreSQL、MySQL、libSQL、Cloudflare D1、Redis。其他后端不显示这些字段。

| 字段 | 默认 | 说明 |
|---|---|---|
| `chunked` | `false` | 开启后把整份快照切成多块，突破单行/单值大小限制 |
| `chunkSizeKb` | `256` | 块大小，16–4096 KB |
| `chunkShards` | `1` | 块按分片分散存放，1–16 |
| `chunkVerify` | `true` | 读取时校验每块长度与 SHA-256 |

- manifest 仍写入原来的主行/主文档/主 key，由现有 revision CAS 保护；块先写入新 generation，再切换 manifest，旧块随后清理。
- manifest 记录块顺序、分片、长度与 SHA-256，读取时按索引拼接并校验；这是块级索引的实现。
- 关闭 `chunked` 后仍能读取已分块数据；下一次保存会转回单条快照并清理旧块。
- 分块会增加读写次数；只在接近后端大小上限时开启。
- `chunkShards` 只把块分散到不同 key/行，**项目级分片**（每个项目单独存储）尚未实现。

## 分布式锁

- PostgreSQL：会话级 `pg_advisory_lock`（专用连接）。
- MySQL：`GET_LOCK` / `RELEASE_LOCK`（专用连接）。
- Redis：`SET lock NX PX` + 定时续租 + Lua 校验后释放。
- 本地 `DATA_DIR/scoreboard.lock` 始终保留，保护账号文件、上传资产与同机双实例。
- PostgreSQL/MySQL 配置项「跨主机锁」可选“禁用”（`lockMode=none`），用于 CockroachDB、YugabyteDB、PlanetScale 等协议兼容服务；此时仅靠 CAS。
- 锁只保证**单写者**，不提供 active-active 多副本；libSQL/CouchDB/MongoDB/SQL Server/Oracle 仅靠 CAS。
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

## CouchDB 注意事项

- 整份状态保存在 `_id=state` 的单个文档；默认单文档上限约 8MB，系统按 7.5MB 预检迁移与保存。
- 数据库不存在时自动创建（首次启动、测试连接或迁移时）；数据库名必须以小写字母开头，只允许 `a-z`、`0-9`、`_`、`$`、`-`。
- 支持 `http://` 与 `https://`；认证可用 URL 内嵌用户名密码，或填写用户名/密码字段。
- 无跨主机锁，请单实例运行。

## Cloudflare D1 注意事项

- 通过 Cloudflare REST API 访问，需要账户 ID、数据库 ID 与 API Token；不需要安装 SDK。
- 整份状态保存在 `scoreboard_state` 表；单行约 2MB，系统按 1.9MB 预检迁移与保存。
- 表不存在时自动创建；数据库本身需要在 Cloudflare 控制台预先创建。
- 无跨主机锁，请单实例运行。
- 若使用兼容代理，可在「API 地址」中覆盖默认的 `https://api.cloudflare.com`。

## LMDB 注意事项

- 嵌入式 KV，状态保存在 `DATA_DIR` 内的本地目录；**没有远程能力**，只适合单机部署。
- 写事务天然串行化，在事务内读取 `revision` 后条件写入，实现 CAS。
- 需要原生模块 `lmdb`；Node 大版本升级或 Electron 打包后可能需要重建。
- 依赖 mmap 与 POSIX 文件锁，**NFS / EFS 等网络文件系统上不可靠**。
- `Map 大小 (MB)` 是 LMDB 虚拟地址空间上限，不是磁盘占用；按状态规模调整即可。
- 与 SQLite 定位重叠；除非有明确的嵌入式性能需求，否则优先 SQLite。

## S3 / MinIO 注意事项

- 整份状态写入单个对象 `<前缀>/state.json`，使用 `ETag` 与 `If-Match` / `If-None-Match: *` 做 CAS。
- 每次保存都会全量重写对象，延迟与流量明显高于数据库；建议用于低频写入、备份或冷备，不建议作为高频主存。
- 桶需要预先创建；`MinIO` 通常需要开启「Path-style 访问」，并填写 Endpoint。
- 旧版本 MinIO 可能不支持条件 PUT；请使用支持 `If-Match` 的版本。
- 凭证支持 IAM 角色、环境变量或显式访问密钥；无跨主机锁。

## etcd 注意事项

- 通过 etcd v3 HTTP/JSON gateway 访问，Endpoint 形如 `http://127.0.0.1:2379`，不需要安装驱动。
- 整份状态保存在 `<前缀>/state`，使用 key 的 `version` 做事务比较；删除后 version 从 0 重新开始。
- 默认请求上限约 1.5MB，系统按 1.4MB 预检迁移与保存；不要用 K8s 控制面 etcd 存业务数据。
- 支持用户名/密码认证（先调用 `/v3/auth/authenticate` 获取 token）。
- 当前仅实现 CAS，不提供 lease 分布式锁；请单实例运行。

## Google Firestore 注意事项

- 整份状态保存在 `scoreboard_state/state` 单个文档；单文档上限 1MB，系统按 0.9MB 预检迁移与保存。
- 认证优先使用 ADC / Workload Identity；也可在「服务账号文件」填写 JSON 凭证路径，或设置 `GOOGLE_APPLICATION_CREDENTIALS`。
- 项目 ID 必填；数据库 ID 默认 `(default)`；集合不存在时首次写入自动创建。
- 写入使用 Firestore 事务，事务冲突由 SDK 自动重试；revision 不匹配时返回冲突并停止落盘。
- 无跨主机锁，请单实例运行。
- 本地验证可使用 Firestore Emulator（设置 `FIRESTORE_EMULATOR_HOST`）。

## AWS DynamoDB 注意事项

- 表需要预先创建，分区键为字符串 `id`；应用不会自动建表。
- 整份状态保存在 `id=state` 的单项中；单项上限 400KB，系统按 380KB 预检迁移与保存。
- 凭证优先使用 IAM 角色（IRSA/任务角色/实例角色）；也可填写 Access Key 与 Secret，或使用环境变量。
- 读取使用 `ConsistentRead`，避免最终一致读造成误冲突。
- 可用 `DYNAMODB_ENDPOINT` 指向 DynamoDB Local / LocalStack 做本地验证。
- 无跨主机锁，请单实例运行。

## libSQL / Turso 注意事项

- 与 SQLite 相同的表结构与 CAS SQL；支持 `libsql://`、`https://`、`wss://` 与本地 `file:`。
- 远程使用 `authToken`；本地 `file:` 可留空。
- 不要把 embedded replica 作为权威写路径，避免读到旧 revision。
- 无跨主机锁，请单实例运行。

## 驱动与打包

- SQLite 优先使用 Node 24 / Electron 内置的 `node:sqlite`：与 Node/Electron 的 ABI 无关，打包后的 Electron 不需要 `electron-rebuild`，迁移与启动也不会再因原生模块版本不匹配返回 500。
- 只有运行环境没有 `node:sqlite`（Node < 22.5 等）时才回退 `better-sqlite3`；此时切换 Node 大版本后执行 `npm rebuild better-sqlite3`，Electron 中需 `npx electron-rebuild better-sqlite3`。驱动加载失败会返回 422 与具体原因，而不是笼统的「服务器内部错误」。
- `mongodb`、`mssql`、`redis` 为纯 JS。
- `@libsql/client` 远程连接为纯 JS；本地 `file:` 依赖平台原生包（可选依赖）。
- `lmdb` 是原生模块（N-API，提供平台预编译包）；切换 Node 大版本或 Electron 打包后按提示重建。
- `oracledb` 使用 Thin 模式，不需要 Instant Client；包体积较大，Alpine 上若无预编译包可能跳过安装，不影响其他后端。
- Alpine 镜像构建会现场编译 `better-sqlite3`（musl 无预编译包）。

## 健康检查与数据位置

- 管理端「存储后端」对话框的「当前运行中」会显示**数据目录**与**数据位置**：文件后端（JSON / TXT / SQLite / LMDB）显示绝对路径，远端后端显示不含密码的连接目标；均可一键复制。`GET /api/v1/storage` 的 `location` 字段提供同一信息。
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
| CouchDB 保存返回 413 | 快照超过单文档上限，精简项目或改用 PostgreSQL |
| libSQL 驱动缺失 | `npm install @libsql/client` |
| D1 返回 401/403 | 检查 API Token 是否有效、是否包含 D1 读写权限 |
| D1 保存失败提示超限 | 快照超过 1.9MB，精简项目或改用 PostgreSQL |
| DynamoDB 启动报「表不存在」 | 先创建分区键为字符串 `id` 的表，或检查 `DYNAMODB_TABLE` |
| DynamoDB 认证失败 | 检查 IAM 角色/访问密钥，或本地 Endpoint 配置 |
| DynamoDB 保存失败提示超限 | 快照超过 380KB，精简项目或改用 PostgreSQL |
| Firestore 认证失败 | 检查 ADC、Workload Identity 或服务账号文件权限 |
| Firestore 保存失败提示超限 | 快照超过 0.9MB，精简项目或改用 PostgreSQL |
| S3 条件写返回 412 | 检测到并发写入；正常冲突，重启或检查第二个实例 |
| S3 保存变慢 | 对象存储全量重写，改用数据库或降低写入频率 |
| etcd 保存失败提示超限 | 快照超过 1.4MB，精简项目或改用 PostgreSQL |
| etcd 认证失败 | 检查用户名/密码与 etcd 的 auth 是否启用 |
| LMDB 驱动缺失或 ABI 错误 | `npm install lmdb`，必要时重建原生模块 |
| LMDB 放在 NFS 上异常 | 改用本地磁盘；LMDB 不支持网络文件系统 |
| SQLite 驱动加载失败 | 优先确认 Node/Electron 内置 `node:sqlite` 可用；仅在回退 `better-sqlite3` 时执行 `npm rebuild better-sqlite3`（Electron 用 `electron-rebuild`） |
| MySQL 报包过大 | 提高 `max_allowed_packet`，或改用 PostgreSQL |

## 测试

```bash
npm run test:storage
TEST_PG_URL=postgres://... TEST_MYSQL_URL=mysql://... \
TEST_MONGO_URL=mongodb://... TEST_REDIS_URL=redis://... \
TEST_LIBSQL_URL=libsql://... TEST_COUCHDB_URL=http://... \
TEST_D1_ACCOUNT_ID=... TEST_D1_DATABASE_ID=... TEST_D1_API_TOKEN=... \
TEST_DYNAMODB_ENDPOINT=http://localhost:8000 TEST_DYNAMODB_TABLE=scoreboard_test \
TEST_FIRESTORE_PROJECT_ID=... TEST_FIRESTORE_DATABASE_ID='(default)' \
TEST_S3_ENDPOINT=http://localhost:9000 TEST_S3_BUCKET=scoreboard-test \
TEST_ETCD_ENDPOINT=http://localhost:2379 \
  npm run test:storage
```

SQL Server / Oracle 可通过 `TEST_MSSQL_URL`、`TEST_ORACLE_URL` 在具备实例时运行。CouchDB 远程测试会创建并删除 `scoreboard_test_<pid>` 数据库；libSQL 远程测试会清空目标表，请使用专用测试实例。无外部服务时，CouchDB、D1、DynamoDB、Firestore、S3 与 etcd 由本地 mock 覆盖，libSQL 与 LMDB 用临时本地文件/目录覆盖。
