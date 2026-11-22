# 存储后端候选评估与推荐清单

本文评估在当前数据模型下还能适配哪些存储后端，并给出推荐顺序。现有 17 种后端（`json`、`txt`、`sqlite`、`postgres`、`mysql`、`mongodb`、`sqlserver`、`oracle`、`redis`、`libsql`、`couchdb`、`d1`、`dynamodb`、`firestore`、`s3`、`etcd`、`lmdb`）的字段、迁移与排错见 [storage-backends.md](storage-backends.md)。

## 当前实施状态

- **已落地**：libSQL/Turso、CouchDB、Cloudflare D1、AWS DynamoDB、Google Firestore、S3/MinIO、etcd、LMDB；通用 secret 字段脱敏与保留；按后端快照上限与运行中保存预检；PostgreSQL/MySQL 的 `lockMode=none`；MariaDB、TiDB、CockroachDB、YugabyteDB、DocumentDB、Upstash 等协议兼容别名。
- **评估结论仍然成立**：LMDB 已按需适配，但无远程能力、原生构建，且与 SQLite 定位重叠；除非有明确的单机嵌入式性能需求，否则仍优先 SQLite。三大云原生方向（AWS / GCP / Cloudflare）均已覆盖。
- **高级选项**：SQLite、PostgreSQL、MySQL、libSQL、D1、Redis 已提供快照分块、块级分片与块哈希索引（默认关闭）；项目级分片（按项目拆分存储）尚未实现，属于下一阶段。

## 数据模型的硬约束

系统把整份状态（项目、人员、团队、设置、主题库）作为一个 JSON 快照保存，没有实体级表/文档，也没有部分更新：

- `save(state, { expectedRevision })` 必须是原子 CAS：
  - `undefined`：无条件覆盖；
  - `null` / `0`：仅创建；
  - 具体 revision：相等才写入，否则抛 `StorageConflictError`。
- 数据库后端的 revision 是整数（首次写入为 1，每次成功写 +1）；文件后端是内容 SHA-256。
- 新后端必须实现 `kind`、`capabilities`、`init`、`load`、`save`、`close`、`health`、`getRevision`、`removeSnapshot`，跨主机锁可选。
- 驱动只能放在 `optionalDependencies`，在 `init()` 内按需加载。

因此，一个后端是否适合，核心看三点：**能否对单行/单文档/单 key 做原子 compare-and-swap**、**单对象大小上限是否够用**、**能否稳定远程连接**。

## 必须复用原有存储后端选择功能

所有新增后端都必须走现有入口，不新增独立配置页面或另一套环境变量：

| 现有能力 | 位置 | 新后端如何接入 |
|---|---|---|
| 管理端「存储后端」对话框 | `web/src/admin/components/StorageDialog.tsx` | 卡片与表单由 `GET /api/v1/storage` 的 `backends` 元数据驱动；只需在 `BACKEND_DEFS` 增加定义，UI 自动渲染 |
| 元数据与字段校验 | `server/storage-config.js` | 增加 `label`、`category`、`description`、`fields`、`envKeys`，沿用现有校验 |
| 注册与工厂 | `server/storage/registry.js`、`server/storage.js` | 增加别名、canonical kind 与 factory case |
| 测试连接 | `POST /api/v1/storage/test` | 实现 `init()` + `health({ probe: true })` 后自动可用 |
| 迁移 / 空库 | `POST /api/v1/storage/migrate` | 实现 `load/save/getRevision/removeSnapshot` 后自动可用 |
| 配置持久化 | `DATA_DIR/storage.json`（0600） | 无需改动；新 secret 字段需先扩展脱敏/合并逻辑 |
| 健康检查 | `GET /api/v1/storage/health`、`/api/health` | 实现统一 `health()` 后自动接入 |

零代码协议兼容后端（MariaDB、TiDB、CockroachDB 等）也通过**别名进入同一个后端列表**，用户仍在原有对话框中选择。

## 先测量状态大小

这是选型的第一道门槛，建议用真实数据统计 p95 与最大值，而不是空库：

| 快照大小 | 出局的后端 |
|---|---|
| > 400 KB | DynamoDB |
| > 1 MB | Firestore |
| > 1.5 MiB | etcd |
| > 2 MB | Cloudflare D1、Cosmos DB (Mongo API) |
| > 8 MB | CouchDB 默认配置（可调高） |
| > 16 MB | MongoDB |

计分板写入有防抖，但主题库、项目与素材引用会让快照持续增长。

## 推荐梯队

| 梯队 | 方案 | 推荐理由 | 适用环境 |
|---|---|---|---|
| **T0** | 零代码协议兼容包 | 复用现有驱动，覆盖绝大多数托管数据库与 Redis 服务，成本最低 | 所有云、自托管、远程 |
| **T1** | **libSQL / Turso** | 与现有 SQLite 后端同构，远程/自托管/托管均可，新增成本最低 | Docker、K8s、多云计算 |
| **T1** | **CouchDB** | 单文档 MVCC（`_rev`）与快照模型天然契合，HTTP 可零驱动 | Docker、K8s、私有云 |
| **T2** | **DynamoDB** | AWS 原生、全托管、条件写即 CAS；状态需 < 400 KB | AWS |
| **T2** | **Firestore** | GCP 原生、事务条件写；状态需 < 1 MB | GCP |
| **T2** | **Cloudflare D1** | 零驱动、边缘 REST；状态需 < 2 MB | Cloudflare |
| **T3** | **S3 / MinIO** | 条件 PUT 可做 CAS，但全量重写延迟高，适合备份/导出而非主存 | 跨云备份、冷备 |
| **T3** | **etcd** | lease + Txn 锁能力最强，但 1.5 MiB 上限、无通用托管 | 已有 etcd 且状态很小的环境 |
| **不建议** | **LMDB** | 无远程能力，原生构建，定位与现有 SQLite 重叠 | — |

**顺序建议**：T0 前置改造与文档 → libSQL → CouchDB → 按主云只选一个（DynamoDB / Firestore / D1）→ S3 备份或 etcd → 跳过 LMDB。

## 候选评估

### 模型契合度与实现要素

| 候选 | CAS 机制 | revision | 驱动 / 是否纯 JS | 单对象上限 | 跨主机锁 |
|---|---|---|---|---|---|
| CouchDB | `PUT` 带 `_rev`，409 冲突；创建用无 `_rev` 的 PUT | 自维护整数或 `_rev` 令牌 | `nano` 或全局 `fetch`（零驱动） | 默认约 8 MB，可调 | 无原生锁 |
| etcd | `Txn` compare `version`/`mod_revision` + `Put` | 整数 | `etcd3`，或 gRPC-gateway + `fetch` | 默认 1.5 MiB | **强**：lease + keepalive |
| DynamoDB | `UpdateItem` + `ConditionExpression` | 整数 | `@aws-sdk/client-dynamodb`，纯 JS、体积大 | 400 KB | 条件写租约，best-effort |
| Firestore | `runTransaction` 读-检查-写，冲突自动重试 | 整数 | `@google-cloud/firestore`，纯 JS、体积大 | 1 MiB | 事务租约，best-effort |
| libSQL / Turso | `UPDATE ... WHERE revision = ?` + `rowsAffected` | 整数 | `@libsql/client`；远程纯 JS，本地 `file:` 需原生包 | SQLite 行上限很大；云端按计划限制 | 无原生锁 |
| LMDB | 写事务内 read-check-write | 整数 | `lmdb` / `node-lmdb`，原生 N-API | `mapSize` 可配 | 仅进程/文件锁 |
| S3 / MinIO | `If-Match: <etag>` 更新、`If-None-Match: *` 创建，412 冲突 | 不透明 ETag（归为 `'hash'`） | `@aws-sdk/client-s3` 或 `minio` | 单 PUT 5 GB，实际受延迟/成本限制 | 无原生锁 |
| Cloudflare D1 | `UPDATE ... WHERE revision = ?` + `meta.changes` | 整数 | 零驱动，`fetch` 调 REST API | 单行约 2 MB（以当前限额为准） | 无原生锁 |

### 运维、迁移与成本

| 候选 | 认证方式 | 迁移 / removeSnapshot | 远程 | 主要坑 |
|---|---|---|---|---|
| CouchDB | HTTP Basic / 反向代理 + TLS | `GET` 当前 `_rev` 后 `DELETE` | 是 | 无条件写需 GET+PUT+409 重试；`_rev` 不透明；8 MB 上限；无锁 |
| etcd | 用户名密码 + TLS/mTLS + RBAC | `Delete` key | 是（仅自托管） | 1.5 MiB 硬限制；无通用托管；勿用 K8s 控制面 etcd |
| DynamoDB | IAM（IRSA/任务角色/实例角色） | `DeleteItem` | 是（仅 AWS） | 400 KB；默认最终一致读，需 `ConsistentRead`；TTL 删除不可靠；SDK 大 |
| Firestore | ADC / Workload Identity | `delete()` | 是（仅 GCP） | 1 MiB；凭据模型与现有密码字段不匹配；按读写计费 |
| libSQL / Turso | `libsql://` / `https://` + auth token | `DELETE` 行 | 是 | token 是 secret；不要用 embedded replica 做权威写路径；关注产品路线 |
| LMDB | 本地文件，无认证 | 事务内删除 | **否** | 原生构建；`mapSize`/`MDB_MAP_FULL`；NFS 不安全 |
| S3 / MinIO | IAM / 访问密钥 / session token | `DeleteObject`；版本化桶需清理所有版本 | 是 | 全量重写延迟；MinIO 对 `If-Match` 支持随版本；ETag 语义不统一 |
| Cloudflare D1 | API Token + account ID + database ID | `DELETE` 行 | 是（仅 Cloudflare） | 单行 2 MB；副本陈旧读；仅 REST/Workers；厂商绑定 |

粗估工作量（含驱动、配置接入、基础测试与文档）：libSQL 2–3 人日，CouchDB 3–4，D1 3–4，DynamoDB / Firestore 4–6，etcd 4–6，S3/MinIO 5–7，LMDB 2–3。前置改造 T0 约 3–4 人日。

## 零代码协议兼容清单

| 服务 | 复用 kind | 级别 | 说明 |
|---|---|---|---|
| MariaDB | mysql | 别名 + 文档（`mariadb` 已存在） | `GET_LOCK`、CAS 可用；注意 `max_allowed_packet`、TLS |
| TiDB | mysql | 别名 + 实测 | `GET_LOCK` 跨节点语义需验证 |
| Aurora MySQL / RDS / Azure MySQL / Cloud SQL MySQL | mysql | 文档 | `GET_LOCK` 可用；RDS Proxy 需会话固定或直连 |
| PlanetScale / Vitess | mysql | 需锁降级 | 不支持 `GET_LOCK`，CAS 可用，需 `lockMode=none` |
| Aurora PG / RDS PG / Cloud SQL PG / Azure PG / AlloyDB / Neon / Supabase | postgres | 文档 | advisory lock 可用；PgBouncer 需 session pooling 或直连 |
| CockroachDB | postgres | 需锁降级 | 不支持 `pg_advisory_lock`；注意 40001 重试与 TLS |
| YugabyteDB | postgres | 需锁降级/实测 | advisory lock 支持随版本变化 |
| Oracle Autonomous | oracle | 文档 | Thin 可用，无分布式锁 |
| Azure SQL / RDS SQL Server | sqlserver | 文档 | 无分布式锁 |
| Amazon DocumentDB | mongodb | 配置 + 实测 | `retryWrites=false`、`tls=true`；16 MB；驱动兼容性需验证 |
| Azure Cosmos DB (Mongo API) | mongodb | 需专项适配 | 文档上限约 2 MB；upsert/`findAndModify` 语义与 RU 成本有限制 |
| Upstash / Vercel KV | redis | 别名 + 文档 | `EVAL`、`SET NX`、Hash 可用；`CONFIG`/`INFO` 可能被禁用（健康检查已容错） |
| ElastiCache / MemoryDB / Azure Cache / Memorystore | redis | 文档 | 仅 standalone / cluster mode disabled |
| Redis Cluster | 需新后端 | 需代码 | 现有客户端不支持 Cluster，需要 cluster client 与 hash tag |
| GCS / Azure Blob | 类 S3 | 需新后端 | 分别用 `ifGenerationMatch` / ETag 条件写 |

**能力降级建议**：不要为每个协议兼容服务新增 kind，而是给 postgres / mysql / mongodb / redis 增加 `lockMode: 'auto' | 'advisory' | 'none'`，在 `init()` 探测后调整 `capabilities.distributedLock`。`state.js` 与 `migrate.js` 都在 `init()` 之后读取 capabilities，时机是安全的。

## 明确不建议适配

- **Elasticsearch / OpenSearch**：搜索库，没有事务型 CAS，刷新与持久化语义复杂。
- **Cassandra / ScyllaDB**：LWT 走 Paxos，单分区热键、tombstone 与运维成本不适合整份快照。
- **Neo4j**：图模型，无 revision CAS 原语。
- **ClickHouse**：OLAP，行级更新是异步 mutation。
- **Memcached**：易失、无持久化。
- **Kafka / Pulsar / RabbitMQ**：日志或消息代理，不是可变快照存储。
- **HBase / Bigtable**：虽有条件写，但热键、集群运维与成本不划算。
- **Cloudflare KV**：最终一致，不支持条件写/CAS；D1 才是合适选择。
- **Riak**：默认最终一致，可能产生 siblings。
- **FoundationDB**：事务能力强，但对本项目运维过度设计。
- **InfluxDB**：时序数据库，无行级 CAS。
- **NFS/EFS 上的文件或 SQLite 后端**：POSIX 锁与 rename 原子性在 NFS 上不可靠。
- **K8s 控制面 etcd 存业务数据**：危及集群控制面。

## 实施前的前置改造（P0）

在新增任何驱动前，需要先补齐：

1. **通用 secret 字段**：`redactStorageConfig()` / `mergeSecrets()` 目前只处理 `password` 与 URL 密码；`authToken`、`apiToken`、`secretAccessKey`、`sessionToken`、service account 需要统一脱敏、合并与错误清洗。
2. **`connectionTarget()` 扩展**：目前只比较 host/port/user/database/server/instance/service/authSource；需加入 `projectId`、`accountId`、`endpoint`、`region`，保证改连接目标必须重新输入密钥。
3. **按 kind 的 `maxSnapshotBytes`**：`server/api/resources/storage.js` 只对 MongoDB 特判 15.5 MB；应改为大小上限表，并在 `save()` 前与迁移前预检。
4. **`lockMode` 能力降级**：覆盖 CockroachDB、YugabyteDB、PlanetScale、DocumentDB、Cosmos、RDS Proxy。
5. **配置校验调整**：`hasControlChars()` 会拒绝 service account JSON 的换行，`bodyLimit` 为 32 KB，`IDENTIFIER_RE` 不允许 `/ ( ) $ +`，会挡住 Firestore `(default)`、S3 key 前缀等；需按字段类型区分。
6. **测试数量去硬编码**：`scripts/verify.mjs` 的 `backends.length === 9` 改为 `KINDS.length` 或常量。

## 分阶段路线

| 阶段 | 目标 | 关键文件 | 测试 |
|---|---|---|---|
| P0 | 基础能力改造 | `server/storage-config.js`、`server/storage/common.js`、`server/api/resources/storage.js`、`scripts/storage.test.mjs`、`scripts/verify.mjs` | secret 脱敏/合并、connectionTarget、大小预检、lockMode、现有 9 种后端回归 |
| P1 | 零代码协议兼容包 | `server/storage/registry.js`、postgres/mysql/mongodb/redis 驱动、`docs/storage-backends.md`、`README.md` | 别名规范化、锁降级、真实环境连接实测（条件跳过） |
| P2 | libSQL / Turso | 新增 `server/storage/libsql.js` 及常规接入点 | externalRoundtrip、CAS、远程 token/TLS、大小边界 |
| P3 | CouchDB | 新增 `server/storage/couchdb.js` 及常规接入点 | `_rev` CAS、409 重试、创建/删除、8 MB 边界 |
| P4 | 按主云选一个：DynamoDB / Firestore / D1 | 新增对应驱动及常规接入点 | 模拟器/真实环境、IAM/ADC/Token、大小上限、限流重试 |
| P5 | S3/MinIO 备份导出；etcd | 新增对应驱动（S3 可先只做导出命令） | 条件 PUT 兼容性、版本化桶、etcd 1.5 MB 边界与 lease 锁 |
| P6 | LMDB（通常跳过） | 新增驱动 + 原生构建处理 | 单写者、mapSize、并发读 |

每个新后端必须覆盖：首次创建、旧 revision 冲突、新 revision 成功、无条件写；`load` 往返与 `removeSnapshot`；迁移 copy 的 canonical JSON SHA-256 校验与 empty 模式；大小边界；锁获取/争用/释放/过期接管；`health({ probe })`；两实例并发 save 恰好一个成功；Docker/K8s/本地模拟器各跑一遍。

## 验收标准（实施时）

1. 管理端「存储后端」对话框能从 `GET /api/v1/storage` 的 `backends` 中看到新后端，并按元数据渲染表单。
2. 「测试连接」返回 `ok:true`。
3. 「迁移」返回 `verified:true`，重启后从新后端恢复数据。
4. 「空库」模式可清空目标并正常启动。
5. 密码/密钥不出现在响应中，`storage.json` 权限保持 `0600`。
6. 通过 `npm run test:storage`、`npm run test:all`、`npm run typecheck`、`npm run build:web`、`npm run verify`。

## 需要提前决定的取舍

- **单写者还是多副本**：CAS 只保证不覆盖新版本；分布式锁才保证同时只有一个写入者。多数云原生后端没有原生锁。
- **云厂商绑定 vs 托管 SQL**：Aurora/RDS/Cloud SQL/Azure Database 的 PostgreSQL/MySQL 可零代码复用现有驱动，通常比云原生 SDK 更稳、更大、更便宜。
- **凭据模型**：推荐 IRSA / Workload Identity / Managed Identity / ADC，而不是把长期密钥存进 `storage.json`。
- **延迟与成本**：对象存储每次 save 全量重写，延迟与费用都高；数据库/Redis 更适合高频写入。
- **SDK 体积**：AWS SDK、Firestore SDK 较大；CouchDB、D1 可用 `fetch` 零驱动。
- **运维负担**：自托管 CouchDB、etcd、MinIO、libSQL 都需要备份、升级、监控、TLS 与故障恢复。
