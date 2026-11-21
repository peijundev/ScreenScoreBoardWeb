'use strict';
// TXT 纯文本后端：内容仍是合法 JSON，但始终缩进，便于人工查看与编辑。
const { createFileSnapshotStorage } = require('./file-snapshot');

/**
 * @param {{ file: string }} options
 */
function createTxtStorage({ file }) {
  return createFileSnapshotStorage({
    kind: 'txt',
    file,
    serialize: (state) => JSON.stringify(state, null, 2) + '\n',
    parse: (text) => JSON.parse(text),
  });
}

module.exports = { createTxtStorage };
