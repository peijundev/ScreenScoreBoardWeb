'use strict';
// S3 / MinIO 后端：整份状态写入单个对象，使用 ETag 条件写做 CAS。
// 定位为备份/冷备或低频写入；每次保存都会全量重写对象。
const { requireDriver, StorageError, StorageConflictError } = require('./common');

const OBJECT_NAME = 'state.json';

/**
 * @param {Record<string, any>} [options]
 */
function createS3Storage(options = {}) {
  const bucket = String(options.bucket || '');
  const key = (String(options.keyPrefix || '').replace(/^\/+|\/+$/g, '') + '/' + OBJECT_NAME)
    .replace(/^\/+/, '');
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let commands = null;
  let revision = /** @type {string|null} */ (null);
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function conflict(current) {
    return new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
      currentRevision: current,
    });
  }

  function isNotFound(error) {
    return Boolean(error) && (
      error.name === 'NoSuchKey' ||
      error.name === 'NotFound' ||
      (error.$metadata && error.$metadata.httpStatusCode === 404)
    );
  }

  function isPreconditionFailed(error) {
    return Boolean(error) && (
      error.name === 'PreconditionFailed' ||
      (error.$metadata && error.$metadata.httpStatusCode === 412)
    );
  }

  function mapError(error) {
    if (!error) return error;
    if (error.name === 'NoSuchBucket') {
      return new StorageError(`S3 桶 ${bucket} 不存在，请先创建`, {
        code: 'STORAGE_CONFIG_INVALID',
      });
    }
    if (
      error.name === 'AccessDenied' ||
      error.name === 'InvalidAccessKeyId' ||
      error.name === 'SignatureDoesNotMatch'
    ) {
      return new StorageError('S3 认证失败，请检查访问密钥或 IAM 角色', {
        code: 'STORAGE_AUTH',
      });
    }
    return error;
  }

  async function headObject() {
    try {
      const result = await client.send(new commands.HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }));
      return result.ETag || null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw mapError(error);
    }
  }

  async function getObject() {
    try {
      const result = await client.send(new commands.GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }));
      const text = typeof result.Body.transformToString === 'function'
        ? await result.Body.transformToString()
        : String(result.Body);
      return { text, etag: result.ETag || null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw mapError(error);
    }
  }

  async function safeCurrentRevision() {
    try {
      return await headObject();
    } catch (_) {
      return null;
    }
  }

  return {
    kind: 's3',
    capabilities: {
      cas: true,
      revision: 'hash',
      distributedLock: false,
      lockKind: null,
      snapshot: 'object',
    },
    async init() {
      if (!bucket) {
        throw new StorageError('S3 需要桶名称', { code: 'STORAGE_CONFIG_INVALID' });
      }
      commands = requireDriver('@aws-sdk/client-s3', 'S3');
      /** @type {Record<string, any>} */
      const config = {
        region: String(options.region || process.env.AWS_REGION || 'us-east-1'),
        forcePathStyle: Boolean(options.forcePathStyle),
      };
      if (options.endpoint) config.endpoint = String(options.endpoint);
      if (options.accessKeyId && options.secretAccessKey) {
        config.credentials = {
          accessKeyId: String(options.accessKeyId),
          secretAccessKey: String(options.secretAccessKey),
          ...(options.sessionToken ? { sessionToken: String(options.sessionToken) } : {}),
        };
      }
      client = new commands.S3Client(config);
      revision = await headObject();
    },
    async load() {
      const object = await getObject();
      if (!object) {
        revision = null;
        return null;
      }
      revision = object.etag;
      try { return JSON.parse(object.text); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const body = JSON.stringify(state);
      try {
        /** @type {Record<string, any>} */
        const params = {
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        };
        if (expectedRevision === undefined) {
          const result = await client.send(new commands.PutObjectCommand(params));
          revision = result.ETag || null;
        } else if (expectedRevision === null) {
          params.IfNoneMatch = '*';
          try {
            const result = await client.send(new commands.PutObjectCommand(params));
            revision = result.ETag || null;
          } catch (error) {
            if (isPreconditionFailed(error)) throw conflict(await safeCurrentRevision());
            throw error;
          }
        } else {
          params.IfMatch = String(expectedRevision);
          try {
            const result = await client.send(new commands.PutObjectCommand(params));
            revision = result.ETag || null;
          } catch (error) {
            if (isPreconditionFailed(error)) throw conflict(await safeCurrentRevision());
            throw error;
          }
        }
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        const mapped = mapError(error);
        lastError = mapped && mapped.message ? mapped.message : String(mapped);
        throw mapped;
      }
    },
    async close() {
      try { if (client && typeof client.destroy === 'function') client.destroy(); } catch (_) {}
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
          await headObject();
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 's3',
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
      await client.send(new commands.DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }));
      revision = null;
    },
  };
}

module.exports = { createS3Storage };
