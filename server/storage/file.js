'use strict';
// JSON 文件后端：整份状态快照写入单个文件。
const { createFileSnapshotStorage } = require('./file-snapshot');

/**
 * @param {{ file: string, pretty?: boolean }} options
 */
function createJsonStorage({ file, pretty = false }) {
  return createFileSnapshotStorage({
    kind: 'json',
    file,
    serialize: (state) => (pretty ? JSON.stringify(state, null, 2) : JSON.stringify(state)),
    parse: (text) => JSON.parse(text),
  });
}

module.exports = { createJsonStorage };
