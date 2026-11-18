import { useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { DISPLAY_STYLES } from '../settings/schema';
import { THEME_GROUPS, themeSettingsOf } from '../theme/schema';
import FieldControl from '../settings/FieldControl';
import { useSettingsCtx } from '../hooks/useSettingsCtx';
import { toast } from '../../shared/ui';
import DialogShell from './DialogShell';

const THEME_FORMAT = 'screenscoreboard.theme';
const THEME_VERSION = 1;

interface ThemeMeta {
  name: string;
  author: string;
  description: string;
  baseStyle: string;
}

export default function ThemeEditorDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const ctx = useSettingsCtx(project);
  const fileInput = useRef<HTMLInputElement>(null);
  const [meta, setMeta] = useState<ThemeMeta>(() => ({
    name: project.name + ' 主题',
    author: '',
    description: '',
    baseStyle: String(project.settings.displayStyle || 'lecture'),
  }));

  function changeBaseStyle(style: string): void {
    setMeta((m) => ({ ...m, baseStyle: style }));
    ctx.set('displayStyle', style, true);
  }

  function exportTheme(): void {
    const theme = {
      format: THEME_FORMAT,
      version: THEME_VERSION,
      name: meta.name.trim() || '未命名主题',
      author: meta.author.trim(),
      description: meta.description.trim(),
      baseStyle: meta.baseStyle,
      settings: themeSettingsOf(ctx.settings),
    };
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeName = (theme.name || 'theme').replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName + '.theme.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('主题已导出');
  }

  async function importTheme(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as {
        format?: unknown;
        version?: unknown;
        name?: unknown;
        author?: unknown;
        description?: unknown;
        baseStyle?: unknown;
        settings?: unknown;
      };
      if (data.format !== THEME_FORMAT) throw new Error('不是有效的计分板主题文件');
      if (data.version !== THEME_VERSION) throw new Error('主题文件版本不受支持');
      if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
        throw new Error('主题缺少 settings');
      }
      const baseStyle = typeof data.baseStyle === 'string' ? data.baseStyle : undefined;
      if (baseStyle && !DISPLAY_STYLES.some(([v]) => v === baseStyle)) {
        throw new Error('主题的基础风格不存在: ' + baseStyle);
      }
      await ctx.op('applyTheme', { baseStyle, settings: data.settings });
      setMeta((m) => ({
        ...m,
        name: typeof data.name === 'string' ? data.name.slice(0, 60) : m.name,
        author: typeof data.author === 'string' ? data.author.slice(0, 60) : m.author,
        description: typeof data.description === 'string' ? data.description.slice(0, 300) : m.description,
        baseStyle: baseStyle || m.baseStyle,
      }));
      toast('主题已应用');
    } catch (err) {
      toast((err as Error).message);
    }
  }

  return (
    <DialogShell
      title="主题编辑器"
      storageKey="themeEditorDialog"
      defaultWidth={1040}
      defaultHeight={760}
      onClose={onClose}
    >
      <div className="set-group">
        <h3>主题信息</h3>
        <label>
          主题名称
          <input
            type="text"
            maxLength={60}
            value={meta.name}
            onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
          />
        </label>
        <label>
          作者
          <input
            type="text"
            maxLength={60}
            value={meta.author}
            onChange={(e) => setMeta((m) => ({ ...m, author: e.target.value }))}
          />
        </label>
        <label>
          说明
          <input
            type="text"
            maxLength={300}
            value={meta.description}
            onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
          />
        </label>
        <label>
          基础风格
          <select value={meta.baseStyle} onChange={(e) => changeBaseStyle(e.target.value)}>
            {DISPLAY_STYLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="data-buttons">
          <button className="btn small primary" type="button" onClick={exportTheme}>
            导出主题
          </button>
          <button className="btn small" type="button" onClick={() => fileInput.current?.click()}>
            导入主题
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void importTheme(e)}
          />
        </div>
        <span className="hint">
          编辑会实时应用到当前项目；导出的 JSON 可在其他项目或设备导入。主题不包含人员/团队数据和上传的图片、音频。
        </span>
      </div>

      {THEME_GROUPS.map((group) => (
        <div className="set-group" key={group.title}>
          <h3>{group.title}</h3>
          {group.fields.map((field) => (
            <FieldControl key={field.t === 'custom' ? field.id : field.k} field={field} ctx={ctx} />
          ))}
        </div>
      ))}
    </DialogShell>
  );
}
