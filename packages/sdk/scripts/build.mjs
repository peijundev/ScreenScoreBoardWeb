import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

function resolveTsc() {
  const candidates = [
    'typescript/bin/tsc',
    path.join(root, 'node_modules/typescript/bin/tsc'),
    path.join(root, '../../node_modules/typescript/bin/tsc'),
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch (_) {
      // 继续尝试下一个位置：包内依赖 → 仓库根依赖
    }
  }
  throw new Error('未找到 TypeScript。请先在仓库根目录执行 npm install，或在 packages/sdk 下执行 npm install。');
}

const tsc = resolveTsc();
rmSync(path.join(root, 'dist'), { recursive: true, force: true });

for (const config of ['tsconfig.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [tsc, '-p', path.join(root, config)], {
    cwd: root,
    stdio: 'inherit',
  });
}

mkdirSync(path.join(root, 'dist/esm'), { recursive: true });
mkdirSync(path.join(root, 'dist/cjs'), { recursive: true });
writeFileSync(path.join(root, 'dist/esm/package.json'), '{"type":"module"}\n');
writeFileSync(path.join(root, 'dist/cjs/package.json'), '{"type":"commonjs"}\n');
console.log('SDK 构建完成：dist/esm + dist/cjs');
