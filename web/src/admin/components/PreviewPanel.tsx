import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { projectOp, useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import { listUsers, setMembersDisabled, type AuthUser } from '../../shared/auth';
import { confirm } from './dialogs';
import {
  DISPLAY_RESOLUTION_LIMITS,
  formatDisplayResolution,
  parseDisplayResolution,
} from '../../shared/displayResolution';
import { DISPLAY_STYLES } from '../settings/schema';
import NumberInput from './NumberInput';

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

/** 把设置值映射回下拉选项：预设命中预设项，其余自定义尺寸归入「自定义…」。 */
function resolutionMode(value: unknown): string {
  const parsed = parseDisplayResolution(value);
  if (!parsed) return 'auto';
  const formatted = formatDisplayResolution(parsed.w, parsed.h);
  return RESOLUTIONS.some((item) => item.value === formatted) ? formatted : 'custom';
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readScale(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? clampSize(n, 0, 100) : 50;
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
  const [mode, setMode] = useState(() => resolutionMode(project.settings.displayResolution));
  const [customW, setCustomW] = useState(
    () => parseDisplayResolution(project.settings.displayResolution)?.w ?? readNumber('previewCustomW', 1280),
  );
  const [customH, setCustomH] = useState(
    () => parseDisplayResolution(project.settings.displayResolution)?.h ?? readNumber('previewCustomH', 720),
  );
  const [resScale, setResScale] = useState(() => readScale(project.settings.displayResolutionScale));
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
      return {
        w: clampSize(customW, DISPLAY_RESOLUTION_LIMITS.minW, DISPLAY_RESOLUTION_LIMITS.maxW),
        h: clampSize(customH, DISPLAY_RESOLUTION_LIMITS.minH, DISPLAY_RESOLUTION_LIMITS.maxH),
      };
    }
    const [w, h] = mode.split('x').map(Number);
    return { w, h };
  }, [mode, customW, customH]);

  // 分辨率保存在项目设置里：预览与真正打开的显示端使用同一逻辑分辨率
  const savedResolution = String(project.settings.displayResolution ?? 'auto');
  useEffect(() => {
    const parsed = parseDisplayResolution(savedResolution);
    setMode(resolutionMode(savedResolution));
    if (parsed) {
      setCustomW(parsed.w);
      setCustomH(parsed.h);
    }
  }, [project.id, savedResolution]);

  useEffect(() => {
    setResScale(readScale(project.settings.displayResolutionScale));
  }, [project.id, project.settings.displayResolutionScale]);

  useEffect(() => {
    localStorage.setItem('previewZoom', String(zoom));
  }, [zoom]);
  useEffect(() => {
    localStorage.setItem('previewCustomW', String(customW));
    localStorage.setItem('previewCustomH', String(customH));
  }, [customW, customH]);

  function saveResolution(value: string): void {
    projectOp(project.id, 'updateSettings', { patch: { displayResolution: value } }).catch(
      (err: Error) => toast(err.message),
    );
  }

  function chooseResolution(value: string): void {
    setMode(value);
    if (value === 'auto') {
      saveResolution('auto');
      return;
    }
    if (value === 'custom') {
      saveResolution(
        formatDisplayResolution(
          clampSize(customW, DISPLAY_RESOLUTION_LIMITS.minW, DISPLAY_RESOLUTION_LIMITS.maxW),
          clampSize(customH, DISPLAY_RESOLUTION_LIMITS.minH, DISPLAY_RESOLUTION_LIMITS.maxH),
        ),
      );
      return;
    }
    saveResolution(value);
  }

  function updateCustomSize(nextW: number, nextH: number): void {
    setCustomW(nextW);
    setCustomH(nextH);
    saveResolution(
      formatDisplayResolution(
        clampSize(nextW, DISPLAY_RESOLUTION_LIMITS.minW, DISPLAY_RESOLUTION_LIMITS.maxW),
        clampSize(nextH, DISPLAY_RESOLUTION_LIMITS.minH, DISPLAY_RESOLUTION_LIMITS.maxH),
      ),
    );
  }

  function updateResScale(next: number): void {
    const value = clampSize(next, 0, 100);
    setResScale(value);
    projectOp(project.id, 'updateSettings', { patch: { displayResolutionScale: value } }).catch(
      (err: Error) => toast(err.message),
    );
  }

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
            title="显示端逻辑分辨率（预览与显示端共用）"
            value={mode}
            onChange={(e) => chooseResolution(e.target.value)}
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
                min={DISPLAY_RESOLUTION_LIMITS.minW}
                max={DISPLAY_RESOLUTION_LIMITS.maxW}
                value={customW}
                title="画布宽度 px"
                onChange={(e) => updateCustomSize(Number(e.target.value), customH)}
              />
              ×
              <input
                type="number"
                min={DISPLAY_RESOLUTION_LIMITS.minH}
                max={DISPLAY_RESOLUTION_LIMITS.maxH}
                value={customH}
                title="画布高度 px"
                onChange={(e) => updateCustomSize(customW, Number(e.target.value))}
              />
            </span>
          )}
          {mode !== 'auto' && (
            <label
              className="preview-res-scale"
              title="内容随分辨率放大的强度：0% 保持 1080p 尺寸，100% 完全按分辨率铺开"
            >
              放大
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={resScale}
                onChange={(e) => updateResScale(Number(e.target.value))}
              />
              <NumberInput
                min={0}
                max={100}
                step={5}
                value={resScale}
                onChange={updateResScale}
                title="直接输入放大强度"
              />
              <span>{resScale}%</span>
            </label>
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
      {isAdmin && <MemberControls project={project} />}
      {isAdmin && <BuzzBar project={project} />}
      {isAdmin && <CountdownBar project={project} />}

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
          ? '预览与显示端 1:1 复刻；固定分辨率会写入项目设置，显示端按该逻辑分辨率渲染并等比缩放到窗口。勾选「编辑布局」后可拖动卡片、拉右下角调整大小；按住 Alt 或开启「平移」后拖动可移动画面。'
          : '当前为只读预览；布局与设置需要管理员权限。'}
      </p>
    </section>
  );
}

function MemberControls({ project }: { project: Project }): JSX.Element {
  const paused = project.settings.memberButtonsPaused === true;
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [accountError, setAccountError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setAccountError('');
    setUsers(null);
    listUsers()
      .then((list) => {
        if (alive) setUsers(list);
      })
      .catch((err: Error) => {
        if (alive) {
          setUsers([]);
          setAccountError(err.message);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const members = (users ?? []).filter((user) => user.role === 'member');
  const disabledCount = members.filter((user) => user.disabled).length;
  const allDisabled = members.length > 0 && disabledCount === members.length;

  async function togglePaused(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await projectOp(project.id, 'updateSettings', {
        patch: { memberButtonsPaused: !paused },
      });
      toast(paused ? '已恢复所有队员按钮' : '已暂停所有队员按钮');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAccounts(): Promise<void> {
    if (busy || !members.length) return;
    const next = !allDisabled;
    if (next) {
      const ok = await confirm({
        title: '停用所有队员账号',
        message:
          '将停用全部 member 账号，并立即吊销它们的会话与令牌。这是全局操作，会影响其他项目里的队员登录。确定继续？',
        confirmText: '全部停用',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const result = await setMembersDisabled(next);
      setUsers(await listUsers());
      toast(
        next
          ? `已停用 ${result.count} 个队员账号`
          : `已启用 ${result.count} 个队员账号`,
      );
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="preview-member-bar">
      <strong>队员</strong>
      <button
        className={'btn small' + (paused ? ' primary' : '')}
        type="button"
        disabled={busy}
        onClick={() => { void togglePaused(); }}
        title="暂停后服务端同时拒绝 memberAction 与 buzzPress"
      >
        {paused ? '恢复所有队员按钮' : '暂停所有队员按钮'}
      </button>
      <button
        className={'btn small' + (allDisabled ? ' primary' : ' danger')}
        type="button"
        disabled={busy || members.length === 0 || Boolean(accountError)}
        onClick={() => { void toggleAccounts(); }}
      >
        {allDisabled ? '启用所有队员账号' : '停用所有队员账号'}
      </button>
      <span className={'hint' + (paused ? ' warn' : '')}>
        {paused ? '所有队员按钮已暂停' : '队员按钮可用'}
      </span>
      <span className="hint">
        {accountError
          ? '未启用登录系统，无法管理队员账号'
          : users === null
            ? '正在读取队员账号…'
            : `队员账号 ${members.length} 个，已停用 ${disabledCount} 个（全局）`}
      </span>
    </div>
  );
}

function BuzzBar({ project }: { project: Project }): JSX.Element {
  const runtime = useAppStore((s) => s.runtime);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const buzz = runtime?.buzz?.[project.id] ?? null;
  const offset = runtime?.serverNow ? runtime.serverNow - Date.now() : 0;
  const remaining = buzz?.endsAt
    ? Math.max(0, Math.ceil((buzz.endsAt - (now + offset)) / 1000))
    : 0;
  const enabled = project.settings.featureBuzzer === true;
  const memberConsole = project.settings.featureMemberConsole !== false;
  const winner = buzz?.winner ?? null;

  let status = '未开始';
  if (buzz) {
    if (buzz.phase === 'prepare') status = `准备中 · 剩余 ${remaining} 秒`;
    else if (buzz.phase === 'open') {
      status = buzz.endsAt ? `抢答中 · 剩余 ${remaining} 秒` : '抢答中 · 等待第一个按下';
    } else if (winner) {
      status = `已锁定：${winner.personName} → ${winner.targetName}`;
    } else {
      status = '本轮无人抢答';
    }
    if (winner && buzz.phase === 'open') {
      status = `已锁定：${winner.personName} → ${winner.targetName}`;
    }
  }

  async function start(): Promise<void> {
    setBusy(true);
    try {
      await projectOp(project.id, 'buzzStart');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function end(): Promise<void> {
    setBusy(true);
    try {
      await projectOp(project.id, 'buzzEnd');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="preview-buzz-bar">
      <strong>抢答</strong>
      <button
        className="btn small primary"
        type="button"
        disabled={!enabled || !memberConsole || Boolean(buzz) || busy}
        onClick={() => { void start(); }}
      >
        开始抢答
      </button>
      <button
        className="btn small danger"
        type="button"
        disabled={!buzz || busy}
        onClick={() => { void end(); }}
      >
        结束抢答
      </button>
      <span className={'hint' + (buzz ? ' is-live' : '')}>{status}</span>
      {!enabled && (
        <span className="hint">在「人员功能菜单」中启用抢答模式</span>
      )}
      {enabled && !memberConsole && (
        <span className="hint">队员控制台未启用，队员无法按按钮</span>
      )}
    </div>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function CountdownBar({ project }: { project: Project }): JSX.Element {
  const runtime = useAppStore((s) => s.runtime);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const countdown = runtime?.countdowns?.[project.id] ?? null;
  const buzz = runtime?.buzz?.[project.id] ?? null;
  const offset = runtime?.serverNow ? runtime.serverNow - Date.now() : 0;
  const enabled = project.settings.featureCountdown === true;
  const duration = Math.min(3600, Math.max(1, Number(project.settings.countdownDurationSec) || 300));
  const state = countdown?.state;
  const remaining = state === 'running'
    ? Math.max(0, (countdown?.endsAt ?? 0) - (now + offset))
    : (countdown?.remainingMs ?? 0);
  const running = state === 'running' && remaining > 0;
  const paused = state === 'paused';
  const ended = state === 'ended' || (state === 'running' && remaining <= 0);
  const status = !countdown
    ? '未开始'
    : running
      ? `进行中 ${formatCountdown(remaining)}`
      : paused
        ? `已暂停 ${formatCountdown(remaining)}`
        : ended ? '时间到' : '未开始';
  const lockedByBuzz = Boolean(buzz);

  async function run(
    op: 'countdownStart' | 'countdownPause' | 'countdownResume' | 'countdownReset' | 'updateSettings',
    payload?: Record<string, unknown>,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await projectOp(project.id, op, payload);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="preview-countdown">
      <label className="cd-enable">
        <input
          type="checkbox"
          checked={enabled}
          disabled={lockedByBuzz || busy}
          onChange={(e) => { void run('updateSettings', { patch: { featureCountdown: e.target.checked } }); }}
        />
        启用倒计时
      </label>
      <label>
        时长（秒）
        <NumberInput
          min={1}
          max={3600}
          step={1}
          value={duration}
          disabled={lockedByBuzz || busy}
          title="倒计时时长（秒）"
          onChange={(next) => { void run('updateSettings', { patch: { countdownDurationSec: next } }); }}
        />
      </label>
      <div className="cd-btns">
        <button
          className="btn small"
          type="button"
          disabled={!enabled || lockedByBuzz || running || busy}
          onClick={() => { void run('countdownStart', { durationSec: duration }); }}
        >
          开始
        </button>
        <button
          className="btn small"
          type="button"
          disabled={!enabled || lockedByBuzz || !running || busy}
          onClick={() => { void run('countdownPause'); }}
        >
          暂停
        </button>
        <button
          className="btn small"
          type="button"
          disabled={!enabled || lockedByBuzz || !paused || busy}
          onClick={() => { void run('countdownResume'); }}
        >
          继续
        </button>
        <button
          className="btn small"
          type="button"
          disabled={!enabled || lockedByBuzz || !countdown || busy}
          onClick={() => { void run('countdownReset'); }}
        >
          重置
        </button>
      </div>
      <span className="cd-status" aria-live="polite">{status}</span>
      {lockedByBuzz && <span className="hint">抢答进行中，计时器由抢答控制</span>}
      {!enabled && !lockedByBuzz && <span className="hint">勾选「启用倒计时」后可用</span>}
    </div>
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
