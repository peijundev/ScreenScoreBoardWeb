import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import DialogShell from '../../components/DialogShell';
import FieldControl from '../../settings/FieldControl';
import type { Ctx } from '../../settings/types';
import { DISPLAY_STYLES } from '../../settings/schema';
import { THEME_GROUPS } from '../schema';
import VectorTab from './VectorTab';
import WidgetsTab from './WidgetsTab';
import { detectFormat, parseThemeText, stringifyTheme, type ThemeTextFormat } from '../codec';
import { projectOp } from '../../../shared/store';
import { authFetch } from '../../../shared/auth';
import { toast } from '../../../shared/ui';
import { confirm } from '../../components/dialogs';
import type { Project, Settings } from '../../../shared/types';
import type { ThemeSummary, ThemeV2 } from '../../../shared/theme';

type Tab = 'library' | 'meta' | 'vector' | 'widgets' | 'settings' | 'script' | 'code' | 'preview';

const TABS: Array<[Tab, string]> = [
  ['library', '主题库'],
  ['meta', '元数据'],
  ['vector', '矢量'],
  ['widgets', '控件'],
  ['settings', '外观设置'],
  ['script', '脚本'],
  ['code', 'TOML / JSON'],
  ['preview', '预览'],
];

const SCRIPT_SAMPLE = `function drawTheme(ctx) {
  var top = ctx.people[0];
  if (!top) return [];
  return [
    { op: 'rect', x: 48, y: 48, w: 420, h: 96, rx: 18, fill: '#000000', opacity: 0.35 },
    { op: 'text', x: 72, y: 96, text: '第一名 ' + top.name + '  ' + top.score, size: 30, color: '#ffffff', align: 'left' }
  ];
}`;

function scriptOf(theme: ThemeV2): { enabled: boolean; source: string; entry: string } {
  return theme.script || { enabled: false, source: '', entry: 'drawTheme' };
}

function safeName(name: string): string {
  return (name.trim() || '主题').replace(/[\\/:*?"<>|]/g, '_');
}

async function fetchThemes(): Promise<ThemeSummary[]> {
  const res = await authFetch('/api/themes');
  if (!res.ok) throw new Error('读取主题库失败');
  const data = (await res.json()) as { themes?: ThemeSummary[] };
  return Array.isArray(data.themes) ? data.themes : [];
}

async function fetchTheme(id: string): Promise<ThemeV2> {
  const res = await authFetch('/api/themes/' + encodeURIComponent(id));
  const data = (await res.json()) as { theme?: ThemeV2; error?: string };
  if (!res.ok || !data.theme) throw new Error(data.error || '读取主题失败');
  return data.theme;
}

export default function ThemeStudioDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('library');
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeV2 | null>(null);
  const [code, setCode] = useState('');
  const [codeFormat, setCodeFormat] = useState<ThemeTextFormat>('toml');
  const [codeError, setCodeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const codeThemeId = useRef('');
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const refresh = async (keep?: string | null): Promise<void> => {
    const list = await fetchThemes();
    setThemes(list);
    const id = keep !== undefined ? keep : selected;
    if (id && list.some((t) => t.id === id)) {
      setSelected(id);
    } else if (list.length) {
      setSelected(list[0].id);
    } else {
      setSelected(null);
      setTheme(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchThemes();
        if (cancelled) return;
        setThemes(list);
        if (list.length) {
          const first = await fetchTheme(list[0].id);
          if (!cancelled) {
            setSelected(first.meta.id);
            setTheme(first);
          }
        }
      } catch (e) {
        if (!cancelled) toast(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === 'theme-preview-error') setCodeError(String(e.data.message || '预览失败'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 预览标签页：把本地草稿推给同源 iframe，不写服务端
  useEffect(() => {
    if (tab !== 'preview' || !theme) return;
    const timer = window.setTimeout(() => {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'theme-preview', theme },
        location.origin,
      );
    }, 120);
    return () => window.clearTimeout(timer);
  }, [tab, theme]);

  const settingsCtx = useMemo<Ctx | null>(() => {
    if (!theme) return null;
    return {
      project,
      settings: { ...project.settings, ...theme.settings } as Settings,
      set: (key, value) => {
        setTheme((cur) => cur ? { ...cur, settings: { ...cur.settings, [key]: value } } : cur);
      },
      op: (name, payload) => projectOp(project.id, name, payload),
    };
  }, [project, theme]);

  async function selectTheme(id: string): Promise<void> {
    setBusy(true);
    try {
      const t = await fetchTheme(id);
      setSelected(t.meta.id);
      setTheme(t);
      setCodeError('');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function newTheme(): Promise<void> {
    setBusy(true);
    try {
      const ack = (await projectOp(project.id, 'themeCreate', { name: '新主题' })) as { themeId?: string };
      if (!ack?.themeId) throw new Error('创建主题失败');
      await refresh(ack.themeId);
      await selectTheme(ack.themeId);
      setTab('meta');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveToLibrary(t: ThemeV2): Promise<string> {
    const exists = Boolean(t.meta.id) && themes.some((x) => x.id === t.meta.id);
    let id = t.meta.id;
    if (exists) {
      const ack = (await projectOp(project.id, 'themeUpdate', {
        themeId: id,
        theme: t as unknown as Record<string, unknown>,
      })) as { themeId?: string };
      if (!ack?.themeId) throw new Error('保存主题失败');
      id = ack.themeId;
    } else {
      const ack = (await projectOp(project.id, 'themeImport', {
        theme: t as unknown as Record<string, unknown>,
      })) as { themeId?: string };
      if (!ack?.themeId) throw new Error('保存主题失败');
      id = ack.themeId;
    }
    const fresh = await fetchTheme(id);
    setTheme(fresh);
    setSelected(id);
    await refresh(id);
    return id;
  }

  async function saveLibrary(): Promise<void> {
    if (!theme) return;
    setBusy(true);
    try {
      await saveToLibrary(theme);
      toast('已保存到主题库');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(): Promise<void> {
    if (!theme) return;
    setBusy(true);
    try {
      await projectOp(project.id, 'draftSave', {
        theme: theme as unknown as Record<string, unknown>,
      });
      toast('草稿已保存');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadDraft(): Promise<void> {
    setBusy(true);
    try {
      const res = await authFetch('/api/projects/' + encodeURIComponent(project.id) + '/theme-draft');
      const data = (await res.json()) as { theme?: ThemeV2 | null; error?: string };
      if (!res.ok) throw new Error(data.error || '读取草稿失败');
      if (!data.theme) {
        toast('当前项目还没有主题草稿');
        return;
      }
      setTheme(data.theme);
      setSelected(null);
      setTab('meta');
      toast('已载入项目草稿');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function publishAndApply(): Promise<void> {
    if (!theme) return;
    setBusy(true);
    try {
      const id = await saveToLibrary(theme);
      await projectOp(project.id, 'themeApply', { themeId: id });
      toast('主题已发布并应用');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyExisting(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      await projectOp(project.id, 'themeApply', { themeId: selected });
      toast('主题已应用到当前项目');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function duplicateTheme(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      const ack = (await projectOp(project.id, 'themeDuplicate', {
        themeId: selected,
      })) as { themeId?: string };
      if (!ack?.themeId) throw new Error('复制主题失败');
      await refresh(ack.themeId);
      await selectTheme(ack.themeId);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTheme(): Promise<void> {
    if (!selected) return;
    const ok = await confirm({
      title: '删除主题',
      message: '确定删除这个主题？引用它的项目会自动解绑。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await projectOp(project.id, 'themeDelete', { themeId: selected });
      setTheme(null);
      setSelected(null);
      await refresh(null);
      toast('主题已删除');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File): Promise<void> {
    setBusy(true);
    try {
      const parsed = parseThemeText(await file.text());
      parsed.theme.meta.id = '';
      setTheme(parsed.theme);
      setSelected(null);
      setCodeFormat(parsed.format);
      setTab('meta');
      toast('已导入到编辑器，保存后进入主题库');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function exportTheme(format: ThemeTextFormat): void {
    if (!theme) return;
    try {
      const text = stringifyTheme(theme, format);
      const blob = new Blob([text], { type: format === 'toml' ? 'text/plain;charset=utf-8' : 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName(theme.meta.name) + (format === 'toml' ? '.theme.toml' : '.theme.json');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }

  function syncCodeFromTheme(format = codeFormat): void {
    if (!theme) return;
    setCodeFormat(format);
    try {
      setCode(stringifyTheme(theme, format));
      setCodeError('');
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : String(e));
    }
  }

  function applyCode(): void {
    try {
      const parsed = parseThemeText(code);
      setTheme(parsed.theme);
      setCodeFormat(parsed.format);
      setCodeError('');
      toast('代码已应用到编辑器');
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : String(e));
    }
  }

  // 切换主题时丢弃上一份代码文本，避免把旧主题误存到新主题
  useEffect(() => {
    const id = theme?.meta.id || '';
    if (id !== codeThemeId.current) {
      codeThemeId.current = id;
      setCode('');
      setCodeError('');
    }
  }, [theme?.meta.id]);

  // 打开代码页时若还没有草稿文本，自动从主题生成一次（主题异步加载也覆盖）
  useEffect(() => {
    if (tab === 'code' && theme && !code) syncCodeFromTheme(codeFormat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, theme, code]);

  function changeCodeFormat(next: ThemeTextFormat): void {
    if (!code.trim()) {
      syncCodeFromTheme(next);
      return;
    }
    try {
      const parsed = parseThemeText(code);
      setCode(stringifyTheme(parsed.theme, next));
      setCodeFormat(next);
      setCodeError('');
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : String(e));
    }
  }

  const selectedSummary = themes.find((t) => t.id === selected);

  return (
    <DialogShell
      title="主题工作室"
      storageKey="themeStudio"
      defaultWidth={1120}
      defaultHeight={760}
      onClose={onClose}
    >
      <div className="theme-studio">
        <div className="theme-studio-bar">
          <div className="settings-tabs theme-studio-tabs">
            {TABS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={tab === value ? 'active' : ''}
                onClick={() => {
                  setTab(value);
                  if (value === 'code' && theme) syncCodeFromTheme(detectFormat(code) || codeFormat);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="theme-studio-actions">
            <button className="btn small" type="button" disabled={!theme || busy} onClick={() => void saveDraft()}>
              存草稿
            </button>
            <button className="btn small" type="button" disabled={!theme || busy} onClick={() => void saveLibrary()}>
              存主题库
            </button>
            <button className="btn small" type="button" disabled={!theme || busy} onClick={() => void publishAndApply()}>
              发布并应用
            </button>
          </div>
        </div>

        {tab === 'library' && (
          <div className="theme-lib">
            <div className="theme-lib-side">
              <div className="theme-lib-actions">
                <button className="btn small" type="button" disabled={busy} onClick={() => void newTheme()}>
                  新建
                </button>
                <button className="btn small" type="button" disabled={!selected || busy} onClick={() => void duplicateTheme()}>
                  复制
                </button>
                <button className="btn small danger" type="button" disabled={!selected || busy} onClick={() => void deleteTheme()}>
                  删除
                </button>
              </div>
              <div className="theme-lib-list">
                {loading && <p className="hint">读取主题库…</p>}
                {!loading && !themes.length && <p className="hint">还没有主题，点「新建」从零开始。</p>}
                {themes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={'theme-lib-item' + (t.id === selected ? ' active' : '')}
                    onClick={() => void selectTheme(t.id)}
                  >
                    <strong>{t.name}</strong>
                    <span className="hint">
                      rev {t.revision} · {t.layers} 层 · {t.widgets} 控件
                    </span>
                  </button>
                ))}
              </div>
              <div className="theme-lib-actions">
                <button className="btn small" type="button" disabled={busy} onClick={() => void loadDraft()}>
                  载入项目草稿
                </button>
                <button className="btn small" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
                  导入文件
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.toml,.theme.json,.theme.toml,application/json,text/plain"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>
            <div className="theme-lib-main">
              {selectedSummary ? (
                <>
                  <h3>{selectedSummary.name}</h3>
                  <p className="hint">
                    {selectedSummary.author || '未填写作者'} · 修订 {selectedSummary.revision} ·{' '}
                    {(selectedSummary.bytes / 1024).toFixed(1)} KB
                  </p>
                  <p>{selectedSummary.description || '暂无说明'}</p>
                  <div className="theme-lib-actions">
                    <button className="btn small" type="button" disabled={busy} onClick={() => void applyExisting()}>
                      应用到项目
                    </button>
                    <button className="btn small" type="button" disabled={!theme} onClick={() => exportTheme('json')}>
                      导出 JSON
                    </button>
                    <button className="btn small" type="button" disabled={!theme} onClick={() => exportTheme('toml')}>
                      导出 TOML
                    </button>
                  </div>
                </>
              ) : (
                <p className="hint">从左侧选择主题，或新建 / 载入草稿 / 导入文件。</p>
              )}
            </div>
          </div>
        )}

        {tab === 'meta' && theme && (
          <div className="theme-meta">
            <label>
              主题名称
              <input
                value={theme.meta.name}
                maxLength={60}
                onChange={(e) => setTheme({ ...theme, meta: { ...theme.meta, name: e.target.value } })}
              />
            </label>
            <label>
              作者
              <input
                value={theme.meta.author}
                maxLength={60}
                onChange={(e) => setTheme({ ...theme, meta: { ...theme.meta, author: e.target.value } })}
              />
            </label>
            <label>
              基础风格
              <select
                value={theme.meta.baseStyle}
                onChange={(e) => setTheme({ ...theme, meta: { ...theme.meta, baseStyle: e.target.value } })}
              >
                {DISPLAY_STYLES.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              说明
              <textarea
                rows={4}
                maxLength={300}
                value={theme.meta.description}
                onChange={(e) => setTheme({ ...theme, meta: { ...theme.meta, description: e.target.value } })}
              />
            </label>
            <p className="hint">主题 id：{theme.meta.id || '保存后由服务端生成'} · 修订 {theme.meta.revision}</p>
          </div>
        )}

        {tab === 'vector' && theme && (
          <VectorTab theme={theme} onChange={setTheme} />
        )}

        {tab === 'widgets' && theme && (
          <WidgetsTab theme={theme} onChange={setTheme} />
        )}

        {tab === 'script' && theme && (() => {
          const script = scriptOf(theme);
          const patchScript = (patch: Partial<typeof script>): void => {
            setTheme({ ...theme, script: { ...script, ...patch } });
          };
          return (
            <div className="theme-script-editor">
              <div className="theme-script-head">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={script.enabled}
                    onChange={(e) => patchScript({ enabled: e.target.checked })}
                  />
                  启用主题脚本
                </label>
                <label>
                  入口函数
                  <input
                    value={script.entry}
                    maxLength={64}
                    placeholder="drawTheme"
                    onChange={(e) => patchScript({ entry: e.target.value })}
                  />
                </label>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => patchScript({ source: SCRIPT_SAMPLE })}
                >
                  插入示例
                </button>
              </div>
              <p className={project.settings.themeScriptEnabled ? 'hint' : 'hint warn'}>
                {project.settings.themeScriptEnabled
                  ? '项目已允许主题脚本；脚本在沙箱中执行，只返回受限绘制指令。'
                  : '项目未开启「主题脚本」，保存后脚本也不会在大屏执行。请到项目设置 → 特效 → 主题脚本开启。'}
              </p>
              <textarea
                className="theme-code theme-script-code"
                spellCheck={false}
                maxLength={32768}
                value={script.source}
                placeholder="function drawTheme(ctx) { return []; }"
                onChange={(e) => patchScript({ source: e.target.value })}
              />
              <p className="hint">
                ctx 提供 projectName、title、people、teams、scores、countdown、t/frame、画布尺寸等只读数据。
                脚本必须同步返回数组；每条指令只能是 rect / ellipse / line / text / path / polygon。
                运行环境禁止 DOM、网络、表单和导航，超过单帧超时会终止并暂停。
              </p>
            </div>
          );
        })()}

        {tab === 'settings' && settingsCtx && (
          <div className="theme-settings-grid">
            {THEME_GROUPS.map((group) => (
              <section className="set-group" key={group.title}>
                <h3>{group.title}</h3>
                {group.fields.map((field, index) => (
                  <FieldControl
                    key={field.t === 'custom' ? field.id : field.k + ':' + index}
                    field={field}
                    ctx={settingsCtx}
                  />
                ))}
              </section>
            ))}
          </div>
        )}

        {tab === 'code' && (
          <div className="theme-code-wrap">
            <div className="theme-code-bar">
              <div className="settings-tabs">
                <button type="button" className={codeFormat === 'toml' ? 'active' : ''} onClick={() => changeCodeFormat('toml')}>
                  TOML
                </button>
                <button type="button" className={codeFormat === 'json' ? 'active' : ''} onClick={() => changeCodeFormat('json')}>
                  JSON
                </button>
              </div>
              <div className="theme-lib-actions">
                <button className="btn small" type="button" disabled={!theme} onClick={() => syncCodeFromTheme(codeFormat)}>
                  从编辑器生成
                </button>
                <button className="btn small" type="button" onClick={applyCode}>
                  应用到编辑器
                </button>
                <button className="btn small" type="button" disabled={!theme} onClick={() => exportTheme(codeFormat)}>
                  导出文件
                </button>
              </div>
            </div>
            <textarea
              className="theme-code"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {codeError && <pre className="theme-code-error">{codeError}</pre>}
            <p className="hint">
              支持 v2 主题（TOML / JSON 自动识别）；v1 `.theme.json` 导入后会自动升级。保存前由服务端做权威校验。
            </p>
          </div>
        )}

        {tab === 'preview' && (
          <div className="theme-preview-wrap">
            <p className="hint">预览的是当前编辑器里的草稿；「发布并应用」后才会写入正式布局。</p>
            <iframe
              ref={frameRef}
              className="theme-preview-frame"
              title="主题草稿预览"
              src={'/display-v2?project=' + encodeURIComponent(project.id)}
              onLoad={() => {
                if (theme) frameRef.current?.contentWindow?.postMessage(
                  { type: 'theme-preview', theme },
                  location.origin,
                );
              }}
            />
          </div>
        )}
      </div>
    </DialogShell>
  );
}
