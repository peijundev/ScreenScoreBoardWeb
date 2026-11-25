import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  THEME_FORMAT, THEME_VERSION, emptyTheme, type ThemeV2,
} from '../../shared/theme';

export type ThemeTextFormat = 'json' | 'toml';

export interface ParsedTheme {
  theme: ThemeV2;
  format: ThemeTextFormat;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** v1 纯 settings 主题 → v2 最小形态（服务端仍会做权威校验） */
function upgradeV1(raw: Record<string, unknown>): ThemeV2 {
  const base = emptyTheme(String(raw.name || '导入的主题'));
  return {
    ...base,
    meta: {
      ...base.meta,
      name: String(raw.name || base.meta.name),
      author: String(raw.author || ''),
      description: String(raw.description || ''),
      baseStyle: String(raw.baseStyle || 'custom'),
    },
    settings: isObject(raw.settings) ? raw.settings : {},
  };
}

/** v2 主题的最小结构校验：显示端与主题工作室都直接消费这些字段。 */
function assertV2Theme(raw: Record<string, unknown>): void {
  if (!isObject(raw.meta)) throw new Error('主题缺少 meta 信息');
  if (!isObject(raw.canvas) || !isObject(raw.canvas.background)) {
    throw new Error('主题缺少 canvas / canvas.background');
  }
  if (!Array.isArray(raw.layers)) throw new Error('主题缺少 layers 数组');
  for (const layer of raw.layers) {
    if (!isObject(layer) || !Array.isArray(layer.nodes)) {
      throw new Error('主题图层结构非法（layer.nodes 必须是数组）');
    }
  }
  if (!Array.isArray(raw.widgets)) throw new Error('主题缺少 widgets 数组');
  if (!isObject(raw.settings)) throw new Error('主题缺少 settings 对象');
}

export function parseThemeText(text: string): ParsedTheme {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('主题内容为空');

  let raw: unknown = null;
  let format: ThemeTextFormat = 'json';
  try {
    raw = JSON.parse(trimmed);
  } catch (jsonError) {
    try {
      raw = parseToml(trimmed);
      format = 'toml';
    } catch (tomlError) {
      const j = jsonError instanceof Error ? jsonError.message : String(jsonError);
      const t = tomlError instanceof Error ? tomlError.message : String(tomlError);
      throw new Error('JSON 解析失败：' + j + '\nTOML 解析失败：' + t);
    }
  }

  if (!isObject(raw)) throw new Error('主题顶层必须是对象/表');
  if (raw.format !== THEME_FORMAT) throw new Error('不是有效的计分板主题文件（format 不匹配）');
  const version = Number(raw.version);
  if (version === 1) return { theme: upgradeV1(raw), format };
  if (version !== THEME_VERSION) throw new Error('主题版本不受支持（需要 version 2）');
  assertV2Theme(raw);
  return { theme: raw as unknown as ThemeV2, format };
}

/** TOML 不支持 undefined；先走一次 JSON 投影，保持与 JSON 导出完全同构 */
function tomlSafe(theme: ThemeV2): Record<string, unknown> {
  return JSON.parse(JSON.stringify(theme)) as Record<string, unknown>;
}

export function stringifyTheme(theme: ThemeV2, format: ThemeTextFormat): string {
  if (format === 'json') return JSON.stringify(theme, null, 2) + '\n';
  try {
    return stringifyToml(tomlSafe(theme));
  } catch (e) {
    throw new Error('导出 TOML 失败：' + (e instanceof Error ? e.message : String(e)));
  }
}

export function detectFormat(text: string): ThemeTextFormat {
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return 'toml';
  }
}
