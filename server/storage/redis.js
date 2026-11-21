'use strict';
// Redis 后端：hash 快照 + Lua CAS + SET NX 分布式锁。
// 作为权威存储时必须开启 AOF 且使用 noeviction，否则重启/淘汰可能丢数据。
const { requireDriver, StorageConflictError, sleep } = require('./common');

const CAS_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'revision')
if ARGV[1] ~= '' then
  local actual = tonumber(cur or '0')
  local expected = tonumber(ARGV[1])
  if actual ~= expected then return {0, actual} end
end
local rev = redis.call('HINCRBY', KEYS[1], 'revision', 1)
redis.call('HSET', KEYS[1], 'data', ARGV[2], 'updatedAt', ARGV[3])
return {1, rev}
`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * @param {Record<string, any>} [options]
 */
function createRedisStorage(options = {}) {
  /** @type {any} */
  let client = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);
  let lockToken = null;
  /** @type {any} */
  let renewTimer = null;

  const prefix = options.keyPrefix || 'scoreboard';
  const stateKey = prefix + ':state';
  const lockKey = prefix + ':lock';

  function stopRenew() {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }

  return {
    kind: 'redis',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: true,
      lockKind: 'redis',
      snapshot: 'redis-hash',
    },
    async init() {
      const { createClient } = requireDriver('redis', 'Redis');
      const url = options.url || process.env.REDIS_URL || '';
      /** @type {Record<string, any>} */
      const config = {};
      if (url) {
        config.url = url;
        config.socket = { connectTimeout: Number(options.connectTimeoutMs) || 5000 };
      } else {
        config.socket = {
          host: options.host || process.env.REDIS_HOST || '127.0.0.1',
          port: Number(options.port || process.env.REDIS_PORT) || 6379,
          connectTimeout: Number(options.connectTimeoutMs) || 5000,
        };
        if (options.tls) config.socket.tls = true;
        if (options.username) config.username = options.username;
        if (options.password != null) config.password = options.password;
        else if (process.env.REDIS_PASSWORD) config.password = process.env.REDIS_PASSWORD;
        if (options.db != null) config.database = Number(options.db);
      }
      client = createClient(config);
      client.on('error', (error) => {
        lastError = error && error.message ? error.message : String(error);
      });
      await client.connect();
      const data = await client.hGetAll(stateKey);
      revision = Number(data && data.revision) || 0;
    },
    async load() {
      const data = await client.hGetAll(stateKey);
      if (!data || !data.data) {
        revision = 0;
        return null;
      }
      revision = Number(data.revision) || 0;
      try { return JSON.parse(data.data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      const expected = expectedRevision === undefined
        ? ''
        : String(expectedRevision === null ? 0 : expectedRevision);
      try {
        const result = await client.eval(CAS_SCRIPT, {
          keys: [stateKey],
          arguments: [expected, json, String(now)],
        });
        const ok = Number(result && result[0]);
        if (ok !== 1) {
          throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
            currentRevision: result ? Number(result[1]) : 0,
          });
        }
        revision = Number(result[1]);
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    /**
     * @param {string} ownerId
     * @param {{ ttlMs?: number, renewMs?: number, waitMs?: number }} [lockOptions]
     */
    async acquireLock(ownerId, lockOptions = {}) {
      const ttl = Number(lockOptions.ttlMs) || 30000;
      const renew = Number(lockOptions.renewMs) || Math.max(1000, Math.floor(ttl / 3));
      const waitMs = Number(lockOptions.waitMs) || 0;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const result = await client.set(lockKey, ownerId, { NX: true, PX: ttl });
        if (result === 'OK') {
          lockToken = ownerId;
          stopRenew();
          renewTimer = setInterval(() => {
            client.eval(RENEW_SCRIPT, {
              keys: [lockKey],
              arguments: [ownerId, String(ttl)],
            }).then((ok) => {
              if (!ok) {
                lockToken = null;
                lastError = 'Redis 存储锁已丢失';
              }
            }).catch((error) => {
              lastError = error && error.message ? error.message : String(error);
            });
          }, renew);
          if (typeof renewTimer.unref === 'function') renewTimer.unref();
          return { kind: 'redis' };
        }
        if (Date.now() >= deadline) {
          throw new Error('无法获取 Redis 存储锁：已有另一个实例在使用同一键空间');
        }
        await sleep(200);
      }
    },
    async releaseLock() {
      stopRenew();
      if (!lockToken) return;
      const token = lockToken;
      lockToken = null;
      try {
        await client.eval(RELEASE_SCRIPT, { keys: [lockKey], arguments: [token] });
      } catch (_) {}
    },
    async close() {
      stopRenew();
      try { await this.releaseLock(); } catch (_) {}
      try { if (client) await client.quit(); } catch (_) {}
      client = null;
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && client) {
        try {
          const started = Date.now();
          await client.ping();
          latencyMs = Date.now() - started;
          try {
            const info = await client.info('persistence');
            const aof = /aof_enabled:(\d+)/.exec(info);
            if (aof && aof[1] !== '1') {
              warnings.push('Redis AOF 未开启，重启可能丢失最近写入');
            }
            const lastWrite = /aof_last_write_status:(\w+)/.exec(info);
            if (lastWrite && lastWrite[1] !== 'ok') {
              warnings.push('Redis AOF 最近一次写入状态异常：' + lastWrite[1]);
            }
          } catch (_) {}
          try {
            const policy = await client.configGet('maxmemory-policy');
            const value = policy && policy['maxmemory-policy'];
            if (value && value !== 'noeviction') {
              warnings.push('建议 maxmemory-policy=noeviction，避免状态被淘汰');
            }
          } catch (_) {}
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'redis',
        revision,
        latencyMs,
        lastSaveAt: lastSaveAt || null,
        lastError,
        warnings,
      };
    },
    getRevision() {
      return revision;
    },
    async removeSnapshot() {
      await client.del(stateKey);
      revision = 0;
    },
  };
}

module.exports = { createRedisStorage };
