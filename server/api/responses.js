'use strict';
const crypto = require('crypto');
const { send } = require('../static');

function requestId() {
  return 'r_' + crypto.randomBytes(6).toString('hex');
}

function sendData(res, data, meta, status = 200) {
  send(res, status, JSON.stringify({ data: data === undefined ? null : data, meta: meta || {} }), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function sendError(res, error, id) {
  const body = {
    error: {
      code: error.code || 'INTERNAL',
      message: error.message || '服务器内部错误',
      details: error.details,
    },
    meta: { requestId: id || requestId() },
  };
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  // 413 时请求体可能仍有剩余数据，明确关闭连接，避免客户端 keep-alive 悬挂
  if (error.status === 413) headers.Connection = 'close';
  send(res, error.status || 500, JSON.stringify(body), headers);
}

function payloadTooLarge(message) {
  return Object.assign(new Error(message || '请求体超过上限'), {
    name: 'PayloadTooLargeError',
    status: 413,
  });
}

/**
 * 读取原始请求体。超限时继续消费并丢弃剩余数据，
 * 这样 catch 里的结构化 413 才能真正写到客户端，而不是直接断连。
 */
function readRawBody(req, limit = 2 * 1024 * 1024, message) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (exceeded) return;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        reject(payloadTooLarge(message));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!exceeded) reject(error);
    });
  });
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const buf = await readRawBody(req, limit);
  if (!buf.length) return {};
  const text = buf.toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new SyntaxError('请求体不是合法 JSON');
  }
}

module.exports = { requestId, sendData, sendError, readJsonBody, readRawBody };
