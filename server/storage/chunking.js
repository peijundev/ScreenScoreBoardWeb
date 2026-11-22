'use strict';
// 分块快照协议：把整份 JSON 按字节切成多块，manifest 记录块索引、长度与哈希。
// manifest 本身写入后端的主快照位置，仍由各驱动现有的单点 CAS 保护。
const crypto = require('crypto');

const MANIFEST_VERSION = 1;
const DEFAULT_CHUNK_SIZE_KB = 256;
const DEFAULT_CHUNK_SHARDS = 1;
const MAX_CHUNKS = 4096;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {Record<string, any>} [options] */
function normalizeChunkOptions(options = {}) {
  const sizeKb = Number(options.chunkSizeKb);
  const shards = Number(options.chunkShards);
  return {
    enabled: options.chunked === true,
    chunkSizeBytes: Math.max(16, Math.min(4096, Number.isFinite(sizeKb) ? Math.round(sizeKb) : DEFAULT_CHUNK_SIZE_KB)) * 1024,
    shards: Math.max(1, Math.min(16, Number.isFinite(shards) ? Math.floor(shards) : DEFAULT_CHUNK_SHARDS)),
    verify: options.chunkVerify !== false,
  };
}

/**
 * 按 UTF-8 字节切分，但不切断多字节字符。
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string[]}
 */
function splitByBytes(text, maxBytes) {
  if (!text) return [''];
  const chunks = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index);
    const char = String.fromCodePoint(code);
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes > 0 && bytes + size > maxBytes) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += char.length;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/**
 * @param {string} json
 * @param {ReturnType<typeof normalizeChunkOptions>} options
 */
function createChunkPlan(json, options) {
  const parts = splitByBytes(json, options.chunkSizeBytes);
  if (parts.length > MAX_CHUNKS) {
    throw new Error(`分块数量 ${parts.length} 超过上限 ${MAX_CHUNKS}，请增大块大小`);
  }
  const generation = crypto.randomUUID();
  const chunks = parts.map((part, index) => ({
    index,
    shard: index % options.shards,
    bytes: Buffer.byteLength(part, 'utf8'),
    sha256: sha256(part),
  }));
  const manifest = {
    version: MANIFEST_VERSION,
    chunked: true,
    generation,
    shards: options.shards,
    chunkSizeKb: Math.round(options.chunkSizeBytes / 1024),
    verify: options.verify,
    totalBytes: Buffer.byteLength(json, 'utf8'),
    totalSha256: sha256(json),
    chunks,
  };
  return { manifest, parts };
}

/** @param {string} value */
function parseChunkManifest(value) {
  if (typeof value !== 'string' || value.indexOf('"chunked"') < 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && parsed.chunked === true && parsed.version === MANIFEST_VERSION &&
      typeof parsed.generation === 'string' && Array.isArray(parsed.chunks)
    ) {
      return parsed;
    }
  } catch (_) {
    // 不是 manifest，按普通快照处理。
  }
  return null;
}

/** @param {any} manifest @param {{ shard: number, index: number }} chunk */
function chunkRowId(manifest, chunk) {
  return `chunk:${manifest.generation}:${chunk.shard}:${chunk.index}`;
}

/** @param {any} manifest */
function collectChunkIds(manifest) {
  if (!manifest) return [];
  return manifest.chunks.map((chunk) => chunkRowId(manifest, chunk));
}

/**
 * @param {any} manifest
 * @param {(chunk: any) => string|Promise<string|null>} readChunk
 */
async function assembleChunks(manifest, readChunk) {
  const ordered = [...manifest.chunks].sort((a, b) => a.index - b.index);
  const parts = [];
  const verify = manifest.verify !== false;
  for (const chunk of ordered) {
    const value = await readChunk(chunk);
    if (typeof value !== 'string') {
      throw new Error(`分块 ${chunk.index} 数据缺失`);
    }
    if (verify) {
      if (Buffer.byteLength(value, 'utf8') !== Number(chunk.bytes)) {
        throw new Error(`分块 ${chunk.index} 长度校验失败`);
      }
      if (sha256(value) !== chunk.sha256) {
        throw new Error(`分块 ${chunk.index} 哈希校验失败`);
      }
    }
    parts.push(value);
  }
  const json = parts.join('');
  if (verify && manifest.totalSha256 && sha256(json) !== manifest.totalSha256) {
    throw new Error('状态快照总哈希校验失败');
  }
  return json;
}

module.exports = {
  MANIFEST_VERSION,
  MAX_CHUNKS,
  normalizeChunkOptions,
  splitByBytes,
  createChunkPlan,
  parseChunkManifest,
  chunkRowId,
  collectChunkIds,
  assembleChunks,
  sha256,
};
