'use strict';
// AWS DynamoDB 后端：单表单项快照 + revision 条件写 CAS。
// 驱动按需加载；未安装 @aws-sdk/client-dynamodb 时只影响本后端。
const { requireDriver, StorageError, StorageConflictError } = require('./common');

const ITEM_ID = 'state';

/**
 * @param {Record<string, any>} [options]
 */
function createDynamoStorage(options = {}) {
  const tableName = String(options.tableName || 'scoreboard_state');
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let commands = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function conflict(current) {
    return new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
      currentRevision: current,
    });
  }

  function mapError(error) {
    if (!error) return error;
    if (error.name === 'ResourceNotFoundException') {
      return new StorageError(
        `DynamoDB 表 ${tableName} 不存在；请先创建分区键为字符串 id 的表`,
        { code: 'STORAGE_CONFIG_INVALID' },
      );
    }
    if (
      error.name === 'UnrecognizedClientException' ||
      error.name === 'InvalidSignatureException' ||
      error.name === 'AccessDeniedException'
    ) {
      return new StorageError('DynamoDB 认证失败，请检查访问密钥或 IAM 角色', {
        code: 'STORAGE_AUTH',
      });
    }
    return error;
  }

  async function getItem() {
    const result = await client.send(new commands.GetItemCommand({
      TableName: tableName,
      Key: { id: { S: ITEM_ID } },
      ConsistentRead: true,
    }));
    return result.Item || null;
  }

  async function currentRevision() {
    const item = await getItem();
    return item && item.revision ? Number(item.revision.N) || 0 : 0;
  }

  async function safeCurrentRevision() {
    try {
      return await currentRevision();
    } catch (_) {
      return null;
    }
  }

  return {
    kind: 'dynamodb',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'row',
    },
    async init() {
      commands = requireDriver('@aws-sdk/client-dynamodb', 'DynamoDB');
      /** @type {Record<string, any>} */
      const config = {
        region: String(options.region || process.env.AWS_REGION || 'us-east-1'),
      };
      if (options.endpoint) config.endpoint = String(options.endpoint);
      if (options.accessKeyId && options.secretAccessKey) {
        config.credentials = {
          accessKeyId: String(options.accessKeyId),
          secretAccessKey: String(options.secretAccessKey),
          ...(options.sessionToken ? { sessionToken: String(options.sessionToken) } : {}),
        };
      }
      client = new commands.DynamoDBClient(config);
      try {
        await getItem();
      } catch (error) {
        throw mapError(error);
      }
      revision = await currentRevision();
    },
    async load() {
      try {
        const item = await getItem();
        if (!item) {
          revision = 0;
          return null;
        }
        revision = item.revision ? Number(item.revision.N) || 0 : 0;
        if (!item.data || typeof item.data.S !== 'string') return null;
        try { return JSON.parse(item.data.S); } catch (_) { return null; }
      } catch (error) {
        throw mapError(error);
      }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      try {
        if (expectedRevision === undefined) {
          const result = await client.send(new commands.UpdateItemCommand({
            TableName: tableName,
            Key: { id: { S: ITEM_ID } },
            UpdateExpression:
              'SET #data = :data, #revision = if_not_exists(#revision, :zero) + :one, #updatedAt = :now',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#revision': 'revision',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':data': { S: json },
              ':zero': { N: '0' },
              ':one': { N: '1' },
              ':now': { N: String(now) },
            },
            ReturnValues: 'ALL_NEW',
          }));
          revision = Number(result.Attributes.revision.N);
        } else {
          const expected = expectedRevision === null ? 0 : Number(expectedRevision);
          if (expected === 0) {
            try {
              await client.send(new commands.PutItemCommand({
                TableName: tableName,
                Item: {
                  id: { S: ITEM_ID },
                  data: { S: json },
                  revision: { N: '1' },
                  updatedAt: { N: String(now) },
                },
                ConditionExpression: 'attribute_not_exists(#id)',
                ExpressionAttributeNames: { '#id': 'id' },
              }));
              revision = 1;
            } catch (error) {
              if (error && error.name === 'ConditionalCheckFailedException') {
                throw conflict(await safeCurrentRevision());
              }
              throw error;
            }
          } else {
            try {
              const result = await client.send(new commands.UpdateItemCommand({
                TableName: tableName,
                Key: { id: { S: ITEM_ID } },
                UpdateExpression: 'SET #data = :data, #revision = #expected + :one, #updatedAt = :now',
                ConditionExpression: 'attribute_exists(#id) AND #revision = :expected',
                ExpressionAttributeNames: {
                  '#data': 'data',
                  '#revision': 'revision',
                  '#updatedAt': 'updatedAt',
                  '#id': 'id',
                },
                ExpressionAttributeValues: {
                  ':data': { S: json },
                  ':expected': { N: String(expected) },
                  ':one': { N: '1' },
                  ':now': { N: String(now) },
                },
                ReturnValues: 'ALL_NEW',
              }));
              revision = Number(result.Attributes.revision.N);
            } catch (error) {
              if (error && error.name === 'ConditionalCheckFailedException') {
                throw conflict(await safeCurrentRevision());
              }
              throw error;
            }
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
          await getItem();
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'dynamodb',
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
      await client.send(new commands.DeleteItemCommand({
        TableName: tableName,
        Key: { id: { S: ITEM_ID } },
      }));
      revision = 0;
    },
  };
}

module.exports = { createDynamoStorage };
