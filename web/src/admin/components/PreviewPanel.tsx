import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { projectOp } from '../../shared/store';
import { toast } from '../../shared/ui';
import { DISPLAY_STYLES } from '../settings/schema';

const RESOLUTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自适应（跟随窗口）' },
  { value: '1280x720', label: 'HD 1280 × 720' },
  { value: '1600x900', label: 'HD+ 1600 × 900' },
  { value: '1920x1080', label: 'FHD 1920 × 1080' },
  { value: '2560x1440', label: '2K 2560 × 1440' },
  { value: '3840x2160', label: '4K UHD 3840 × 2160' },
  { value: '4096x2160', label: 'DCI 4K 4096 × 2160' },
  { value: '5120x2880', label: '5K 5120 × 2880' },
  { value: '7680x4320', label: '8K 7680 × 4320' },
  { value: 'custom', label: '自定义…' },
];

function readNumber(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export default function PreviewPanel({
  project,
  isAdmin,
}: {
  project: Project;
  isAdmin: boolean;
}): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState(false);
  const [zoom, setZoom] = useState(() => readNumber('previewZoom', 1));
  const [mode, setMode] = useState(() => localStorage.getItem('previewResolution') || 'auto');
  const [customW, setCustomW] = useState(() => readNumber('previewCustomW', 1280));
  const [customH, setCustomH] = useState(() => readNumber('previewCustomH', 720));
  const [fit, setFit] = useState(1);
  const [panMode, setPanMode] = useState(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const canEdit = isAdmin && edit;

  const src = useMemo(
    () => '/display-v2?project=' + encodeURIComponent(project.id) + (canEdit ? '&edit=1' : ''),
    [project.id, canEdit],
  );

  const size = useMemo(() => {
    if (mode === 'auto') return null;
    if (mode === 'custom') {
      return { w: Math.min(15360, Math.max(320, customW)), h: Math.min(8640, Math.max(240, customH)) };
    }
    const [w, h] = mode.split('x').map(Number);
    return { w, h };
  }, [mode, customW, customH]);

  useEffect(() => {
    localStorage.setItem('previewZoom', String(zoom));
  }, [zoom]);
  useEffect(() => {
    localStorage.setItem('previewResolution', mode);
  }, [mode]);
  useEffect(() => {
    localStorage.setItem('previewCustomW', String(customW));
    localStorage.setItem('previewCustomH', String(customH));
  }, [customW, customH]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const recalc = (): void => {
      if (!size) return;
      setFit(Math.min(el.clientWidth / size.w, el.clientHeight / size.h));
    };
    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size]);

  // 与旧版一致：auto 模式用 zoom 缩放，固定分辨率用 transform 缩放并撑开舞台
  useLayoutEffect(() => {
    const s = stage.current;
    const f = frame.current;
    if (!s || !f) return;
    if (!size) {
      s.style.width = '100%';
      s.style.height = '100%';
      f.style.width = '100%';
      f.style.height = '100%';
      f.style.transform = '';
      f.style.zoom = String(zoom);
      return;
    }
    const scale = Math.max(0.25, Math.min(3, zoom)) * fit;
    s.style.width = size.w * scale + 'px';
    s.style.height = size.h * scale + 'px';
    f.style.zoom = '';
    f.style.width = size.w + 'px';
    f.style.height = size.h + 'px';
    f.style.transform = 'scale(' + scale + ')';
    f.style.transformOrigin = 'top left';
  }, [size, fit, zoom]);

  return (
    <section className="panel preview-panel">
      <div className="panel-head">
        <h2>显示端预览</h2>
        <div className="preview-tools">
          <select
            className="preview-resolution"
            title="预览画布分辨率"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {mode === 'custom' && (
            <span className="preview-custom-size">
              <input
                type="number"
                min={320}
                max={15360}
                value={customW}
                title="画布宽度 px"
                onChange={(e) => setCustomW(Number(e.target.value))}
              />
              ×
              <input
                type="number"
                min={240}
                max={8640}
                value={customH}
                title="画布高度 px"
                onChange={(e) => setCustomH(Number(e.target.value))}
              />
            </span>
          )}
          <button className="btn small" type="button" title="缩小预览" onClick={() => setZoom((z) => Math.max(0.25, z - 0.1))}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="btn small" type="button" title="放大预览" onClick={() => setZoom((z) => Math.min(3, z + 0.1))}>
            +
          </button>
          <button className="btn small" type="button" onClick={() => setZoom(1)}>
            重置
          </button>
          <button
            className={'btn small' + (panMode ? ' active' : '')}
            type="button"
            title="开启后可直接拖动预览画面（触屏可用）"
            onClick={() => setPanMode((value) => !value)}
          >
            平移
          </button>
        </div>
      </div>

      {isAdmin && <QuickBar project={project} edit={canEdit} onEditChange={setEdit} />}

      <div
        className={'preview-frame-wrap' + (panMode ? ' pan-mode' : '')}
        ref={wrap}
        onPointerDown={(e) => {
          if (!e.altKey && !panMode) return;
          pan.current = { x: e.clientX, y: e.clientY, left: wrap.current?.scrollLeft ?? 0, top: wrap.current?.scrollTop ?? 0 };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p || !wrap.current) return;
          wrap.current.scrollLeft = p.left - (e.clientX - p.x);
          wrap.current.scrollTop = p.top - (e.clientY - p.y);
        }}
        onPointerUp={() => {
          pan.current = null;
        }}
        onPointerCancel={() => {
          pan.current = null;
        }}
      >
        <div className="preview-stage" ref={stage}>
          <iframe ref={frame} id="display-preview" title="显示端预览" src={src} />
        </div>
      </div>
      <p className="preview-hint">
        {isAdmin
          ? '预览与显示端 1:1 复刻；勾选「编辑布局」后可拖动卡片、拉右下角调整大小；按住 Alt 或开启「平移」后拖动可移动画面。'
          : '当前为只读预览；布局与设置需要管理员权限。'}
      </p>
    </section>
  );
}

function QuickBar({
  project,
  edit,
  onEditChange,
}: {
  project: Project;
  edit: boolean;
  onEditChange: (value: boolean) => void;
}): JSX.Element {
  const s = project.settings;
  const patch = (value: Record<string, unknown>): void => {
    projectOp(project.id, 'updateSettings', { patch: value }).catch((err: Error) => toast(err.message));
  };
  const sortValue =
    s.sortBy === 'manual' ? 'manual' : (s.sortBy as string) + '_' + (s.sortOrder as string);
  const view = String(s.displayView ?? 'cards');

  return (
    <div className="preview-quickbar">
      <label>
        风格
        <select value={String(s.displayStyle ?? 'lecture')} onChange={(e) => patch({ displayStyle: e.target.value })}>
          {DISPLAY_STYLES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        主题
        <select value={String(s.theme)} onChange={(e) => patch({ theme: e.target.value })}>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </label>
      <label>
        列数 <span>{Number(s.columns ?? 4)}</span>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={Number(s.columns ?? 4)}
          onChange={(e) => patch({ columns: Number(e.target.value) })}
        />
      </label>
      <label>
        密度
        <select value={String(s.density)} onChange={(e) => patch({ density: e.target.value })}>
          <option value="comfortable">舒适</option>
          <option value="compact">紧凑</option>
        </select>
      </label>
      <label>
        排序
        <select
          value={sortValue}
          onChange={(e) => {
            const map: Record<string, Record<string, string>> = {
              score_desc: { sortBy: 'score', sortOrder: 'desc' },
              score_asc: { sortBy: 'score', sortOrder: 'asc' },
              created_asc: { sortBy: 'created', sortOrder: 'asc' },
              created_desc: { sortBy: 'created', sortOrder: 'desc' },
              manual: { sortBy: 'manual' },
            };
            patch(map[e.target.value] ?? map.score_desc);
          }}
        >
          <option value="score_desc">分数从高到低</option>
          <option value="score_asc">分数从低到高</option>
          <option value="created_asc">添加顺序（旧→新）</option>
          <option value="created_desc">添加顺序（新→旧）</option>
          <option value="manual">自定义顺序</option>
        </select>
      </label>
      <label>
        强调色
        <input type="color" value={String(s.accent)} onChange={(e) => patch({ accent: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={edit} onChange={(e) => onEditChange(e.target.checked)} /> 编辑布局
      </label>
      <label>
        视图
        <select
          value={view}
          onChange={(e) => {
            const next = e.target.value;
            const extra: Record<string, unknown> = {};
            if (next === 'leaderboard') extra.featureLeaderboard = true;
            if (next === 'welcome') extra.featureWelcome = true;
            patch({ displayView: next, ...extra });
          }}
        >
          <option value="cards">计分板</option>
          <option value="leaderboard">排行榜</option>
          <option value="welcome">欢迎幕布</option>
        </select>
      </label>
    </div>
  );
}
