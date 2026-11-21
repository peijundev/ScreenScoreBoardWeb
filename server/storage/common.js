'use strict';
// 存储后端的公共错误与工具。
const crypto = require('crypto');

/** @param {string|Buffer} value */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 稳定序列化：对象键排序，数组保持顺序。用于迁移回读校验与配置指纹。
 * @param {any} value
 * @returns {string}
 */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJSON(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给 Promise 加超时；超时抛 StorageError。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, label = '存储操作') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new StorageError(`${label}超时（${ms}ms）`, { code: 'STORAGE_TIMEOUT', retryable: true }));
        }, ms);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 仅对可重试的瞬时错误做指数退避重试。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number, shouldRetry?: (error: any) => boolean, label?: string }} [options]
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 300,
    maxDelayMs = 5000,
    shouldRetry = isTransientError,
    label = '存储操作',
  } = options;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      attempt += 1;
      // 日志交给调用方；这里只负责等待
      await sleep(delay + Math.floor(Math.random() * 50));
      void label;
    }
  }
}

/** 网络类瞬时错误；认证/配置/冲突/驱动缺失不重试。 */
function isTransientError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.name === 'StorageConflictError' || error.name === 'StorageDriverMissingError') return false;
  const code = String(error.code || error.errno || '');
  return [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
    'ESOCKET', 'ECONNCLOSED', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST',
    'STORAGE_TIMEOUT', '57P01', '57P02', '57P03', '08000', '08003', '08006',
  ].includes(code) || /timeout|temporar|unavailable|connection (lost|closed)/i.test(String(error.message || ''));
}

/**
 * @typedef {Object} StorageErrorOptions
 * @property {string} [code]
 * @property {boolean} [retryable]
 * @property {any} [details]
 */

class StorageError extends Error {
  /**
   * @param {string} message
   * @param {StorageErrorOptions} [options]
   */
  constructor(message, { code = 'STORAGE_ERROR', retryable = false, details } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

class StorageConfigError extends StorageError {
  /**
   * @param {string} message
   * @param {any} [details]
   */
  constructor(message, details) {
    super(message, {
      code: (details && details.code) || 'STORAGE_CONFIG_INVALID',
      details,
    });
    this.name = 'StorageConfigError';
  }
}

class StorageConflictError extends StorageError {
  /**
   * @param {string} message
   * @param {{ currentRevision?: any }} [options]
   */
  constructor(message, { currentRevision } = {}) {
    super(message, { code: 'STORAGE_CONFLICT', details: { currentRevision } });
    this.name = 'StorageConflictError';
    this.currentRevision = currentRevision;
  }
}

class StorageUnsupportedError extends StorageError {
  /** @param {string} message */
  constructor(message) {
    super(message, { code: 'STORAGE_UNSUPPORTED' });
    this.name = 'StorageUnsupportedError';
  }
}

class StorageDriverMissingError extends StorageError {
  /**
   * @param {string} kind
   * @param {string} packageName
   */
  constructor(kind, packageName) {
    super(`${kind} 存储需要依赖 ${packageName}：npm install ${packageName}`, {
      code: 'STORAGE_DRIVER_MISSING',
      details: { packageName },
    });
    this.name = 'StorageDriverMissingError';
    this.packageName = packageName;
  }
}

/**
 * @param {string} packageName
 * @param {string} kind
 * @returns {any}
 */
function requireDriver(packageName, kind) {
  try {
    return require(packageName);
  } catch (_) {
    throw new StorageDriverMissingError(kind, packageName);
  }
}

module.exports = {
  StorageError,
  StorageConfigError,
  StorageConflictError,
  StorageUnsupportedError,
  StorageDriverMissingError,
  requireDriver,
  sha256,
  canonicalJSON,
  withTimeout,
  retry,
  isTransientError,
  sleep,
};
