import { useState, type JSX } from 'react';
import type { Ctx, CustomRenderer } from './types';
import { uploadAvatar, uploadSound } from '../../shared/api';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import { confirm } from '../components/dialogs';

function ResetLayout({ op }: Ctx): JSX.Element {
  return (
    <div className="data-buttons">
      <button
        className="btn small"
        type="button"
        onClick={() => {
          void (async () => {
            const ok = await confirm({
              title: '重置卡片位置',
              message: '重置所有卡片的自由布局位置？',
              confirmText: '重置',
              danger: true,
            });
            if (!ok) return;
            op('resetLayout').catch((err: Error) => toast(err.message));
          })();
        }}
      >
        重置卡片位置
      </button>
    </div>
  );
}

function BgImage(ctx: Ctx): JSX.Element {
  const { settings, op } = ctx;
  const bgType = String(settings.bgType ?? 'color');
  const bgImage = settings.bgImage ? String(settings.bgImage) : '';
  return (
    <>
      <div className="seg">
        <label className="seg-item">
          <input
            type="radio"
            name="bg-type"
            checked={bgType === 'color'}
            onChange={() => op('updateSettings', { patch: { bgType: 'color' } })}
          />{' '}
          纯色
        </label>
        <label className="seg-item">
          <input
            type="radio"
            name="bg-type"
            checked={bgType === 'image'}
            onChange={() => op('updateSettings', { patch: { bgType: 'image' } })}
          />{' '}
          图片
        </label>
      </div>
      <div className="bg-image-row">
        <label className="file-btn">
          选择背景图
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              uploadAvatar(file)
                .then((path) => op('updateSettings', { patch: { bgImage: path, bgType: 'image' } }))
                .catch((err: Error) => toast(err.message));
              e.target.value = '';
            }}
          />
        </label>
        <button
          className="btn small"
          type="button"
          onClick={() =>
            op('updateSettings', { patch: { bgImage: null, bgType: 'color' } }).catch((err: Error) =>
              toast(err.message),
            )
          }
        >
          移除图片
        </button>
      </div>
      {bgImage && <img className="bg-image-preview" src={'/' + bgImage} alt="背景预览" />}
    </>
  );
}

function LoadFonts(): JSX.Element {
  return (
    <div className="data-buttons">
      <button
        className="btn small"
        type="button"
        onClick={async () => {
          const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
            .queryLocalFonts;
          if (typeof query !== 'function') {
            toast('当前浏览器不支持读取系统字体，请手动输入字体名称');
            return;
          }
          try {
            const fonts = await query();
            const families = Array.from(new Set(fonts.map((f) => f.family).filter(Boolean))).sort((a, b) =>
              a.localeCompare(b),
            );
            const dl = document.getElementById('system-font-list') as HTMLDataListElement | null;
            if (dl) {
              dl.innerHTML = '';
              for (const family of families) {
                const option = document.createElement('option');
                option.value = family;
                dl.appendChild(option);
              }
            }
            toast('已读取 ' + families.length + ' 个系统字体');
          } catch (err) {
            toast('读取系统字体失败：' + (err as Error).message);
          }
        }}
      >
        读取系统字体
      </button>
    </div>
  );
}

function PreviewSpotlight(): JSX.Element {
  return (
    <div className="data-buttons">
      <button
        className="btn small"
        type="button"
        onClick={() => {
          const frame = document.getElementById('display-preview') as HTMLIFrameElement | null;
          frame?.contentWindow?.postMessage({ type: 'preview-spotlight' }, location.origin);
        }}
      >
        预览突显效果
      </button>
    </div>
  );
}

function CustomSound(ctx: Ctx): JSX.Element {
  const { op } = ctx;
  return (
    <div className="sound-row">
      <label className="file-btn">
        上传自定义音效
        <input
          type="file"
          accept="audio/wav,audio/ogg,audio/mpeg,audio/mp4,.wav,.ogg,.mp3,.m4a"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            uploadSound(file)
              .then((path) => op('updateSettings', { patch: { customSound: path } }))
              .catch((err: Error) => toast(err.message));
            e.target.value = '';
          }}
        />
      </label>
      <button
        className="btn small"
        type="button"
        onClick={() =>
          op('updateSettings', { patch: { customSound: '' } }).catch((err: Error) => toast(err.message))
        }
      >
        清除
      </button>
    </div>
  );
}

function CountdownActions(ctx: Ctx): JSX.Element {
  const runtime = useAppStore((s) => s.runtime);
  const c = runtime?.countdowns?.[ctx.project.id];
  const status =
    !c ? '未开始' : c.state === 'running' ? '运行中' : c.state === 'paused' ? '已暂停' : '已结束';
  return (
    <>
      <div className="countdown-btns">
        <button
          className="btn small primary"
          type="button"
          onClick={() =>
            ctx
              .op('countdownStart', { durationSec: Number(ctx.settings.countdownDurationSec) || 300 })
              .catch((err: Error) => toast(err.message))
          }
        >
          开始
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => ctx.op('countdownPause').catch((err: Error) => toast(err.message))}
        >
          暂停
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => ctx.op('countdownResume').catch((err: Error) => toast(err.message))}
        >
          继续
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => ctx.op('countdownReset').catch((err: Error) => toast(err.message))}
        >
          重置
        </button>
      </div>
      <span className="hint">{status}</span>
    </>
  );
}

function ToggleLeaderboard(ctx: Ctx): JSX.Element {
  const view = String(ctx.settings.displayView ?? 'cards');
  const next = view === 'leaderboard' ? 'cards' : 'leaderboard';
  return (
    <div className="data-buttons">
      <button
        className="btn small"
        type="button"
        onClick={() =>
          ctx
            .op('updateSettings', {
              patch: { displayView: next, ...(next === 'leaderboard' ? { featureLeaderboard: true } : {}) },
            })
            .catch((err: Error) => toast(err.message))
        }
      >
        {view === 'leaderboard' ? '切换回计分板' : '切换到排行榜'}
      </button>
    </div>
  );
}

function QuickPresets(ctx: Ctx): JSX.Element {
  const initial = Array.isArray(ctx.settings.quickScorePresets)
    ? (ctx.settings.quickScorePresets as number[]).join(',')
    : '1,5,10,-1';
  const [text, setText] = useState(initial);
  const [error, setError] = useState('');
  return (
    <label>
      快捷分预设（逗号分隔，1–6 个非 0 整数）
      <input
        type="text"
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          const items = value
            .split(/[,，、\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number);
          if (items.length >= 1 && items.length <= 6 && items.every((n) => Number.isInteger(n) && n !== 0)) {
            setError('');
            ctx.set('quickScorePresets', items, true);
          } else {
            setError('格式无效');
          }
        }}
      />
      {error && <span className="hint" style={{ color: 'var(--danger)' }}>{error}</span>}
    </label>
  );
}

function BgmFile(ctx: Ctx): JSX.Element {
  return (
    <div className="sound-row">
      <label className="file-btn">
        上传背景音乐
        <input
          type="file"
          accept="audio/wav,audio/ogg,audio/mpeg,audio/mp4,.wav,.ogg,.mp3,.m4a"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            uploadSound(file)
              .then((path) => ctx.op('updateSettings', { patch: { bgmFile: path } }))
              .catch((err: Error) => toast(err.message));
            e.target.value = '';
          }}
        />
      </label>
      <button
        className="btn small"
        type="button"
        onClick={() =>
          ctx.op('updateSettings', { patch: { bgmFile: '' } }).catch((err: Error) => toast(err.message))
        }
      >
        清除
      </button>
    </div>
  );
}

function WelcomeImage(ctx: Ctx): JSX.Element {
  return (
    <div className="sound-row">
      <label className="file-btn">
        上传欢迎背景图
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            uploadAvatar(file)
              .then((path) => ctx.op('updateSettings', { patch: { welcomeImage: path } }))
              .catch((err: Error) => toast(err.message));
            e.target.value = '';
          }}
        />
      </label>
      <button
        className="btn small"
        type="button"
        onClick={() =>
          ctx.op('updateSettings', { patch: { welcomeImage: '' } }).catch((err: Error) => toast(err.message))
        }
      >
        清除
      </button>
    </div>
  );
}

function DataTools(ctx: Ctx): JSX.Element {
  const [status, setStatus] = useState('');
  const projectId = ctx.project.id;

  return (
    <>
      <div className="data-buttons">
        <button
          className="btn small"
          type="button"
          onClick={() => {
            location.href = '/api/export?project=' + encodeURIComponent(projectId) + '&assets=1';
          }}
        >
          导出项目
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => {
            location.href = '/api/scores.csv?project=' + encodeURIComponent(projectId) + '&scope=all';
          }}
        >
          导出 CSV
        </button>
        <label className="file-btn">
          导入项目
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                const text = await file.text();
                const res = await fetch('/api/import', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: text,
                });
                const data = (await res.json().catch(() => ({}))) as { error?: string; name?: string };
                if (!res.ok) throw new Error(data.error || '导入失败');
                toast('导入成功：' + (data.name ?? ''));
              } catch (err) {
                toast((err as Error).message);
              }
            }}
          />
        </label>
        <button
          className="btn small"
          type="button"
          onClick={async () => {
            try {
              const res = await fetch('/api/backups/run', { method: 'POST' });
              const data = (await res.json().catch(() => ({}))) as { error?: string; file?: string };
              if (!res.ok) throw new Error(data.error || '备份失败');
              setStatus('已备份：' + (data.file ?? ''));
              toast('备份完成');
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        >
          立即备份
        </button>
        <button
          className="btn small"
          type="button"
          onClick={async () => {
            try {
              const data = (await (await fetch('/api/orphans')).json()) as {
                avatars: { count: number };
                sounds: { count: number };
              };
              setStatus('头像孤儿 ' + data.avatars.count + ' 个，音效孤儿 ' + data.sounds.count + ' 个');
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        >
          扫描孤儿文件
        </button>
        <button
          className="btn small danger"
          type="button"
          onClick={async () => {
            const ok = await confirm({
              title: '清理孤儿文件',
              message: '删除超过宽限期且未被引用的上传文件？',
              confirmText: '清理',
              danger: true,
            });
            if (!ok) return;
            try {
              const res = await fetch('/api/orphans/cleanup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              });
              const data = (await res.json().catch(() => ({}))) as { error?: string; removed?: unknown[] };
              if (!res.ok) throw new Error(data.error || '清理失败');
              setStatus('已清理 ' + (data.removed?.length ?? 0) + ' 个文件');
              toast('清理完成');
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        >
          清理孤儿文件
        </button>
      </div>
      <span className="hint">{status}</span>
    </>
  );
}

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return d.getHours() + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function LogTools(ctx: Ctx): JSX.Element {
  const runtime = useAppStore((s) => s.runtime);
  const [open, setOpen] = useState<'log' | 'undo' | null>(null);
  const projectId = ctx.project.id;
  const logs = (runtime?.scoreLogs?.[projectId] ?? []) as Array<{ at: number; label: string; delta: number }>;
  const labels = (runtime?.undoLabels?.[projectId] ?? []) as Array<{ index: number; label: string }>;

  return (
    <>
      <div className="data-buttons">
        <button className="btn small" type="button" onClick={() => setOpen('log')}>
          分数日志
        </button>
        <button className="btn small" type="button" onClick={() => setOpen('undo')}>
          撤销历史
        </button>
      </div>
      {open && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%,-50%)',
            zIndex: 2000,
            width: 480,
            maxHeight: '60vh',
            overflow: 'auto',
            background: 'var(--card)',
            color: 'var(--text)',
            border: '1px solid var(--card-border)',
            padding: 14,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>{open === 'log' ? '分数日志' : '撤销历史'}</strong>
            <button className="btn small" type="button" onClick={() => setOpen(null)}>
              关闭
            </button>
          </div>
          {open === 'log' &&
            (logs.length === 0 ? (
              <p className="hint">暂无分数变化记录</p>
            ) : (
              logs.map((l, i) => (
                <div className="log-row" key={i}>
                  <span className="hint">{formatLogTime(l.at)}</span>
                  <span>{l.label}</span>
                </div>
              ))
            ))}
          {open === 'undo' &&
            (labels.length === 0 ? (
              <p className="hint">没有可撤销的记分</p>
            ) : (
              labels.map((l) => (
                <button
                  key={l.index}
                  className="btn small undo-to"
                  style={{ textAlign: 'left', marginBottom: 6 }}
                  onClick={() => {
                    ctx
                      .op('undoTo', { keep: l.index })
                      .then((res) => {
                        toast('已连续撤销 ' + ((res as { count?: number }).count ?? 0) + ' 步');
                        setOpen(null);
                      })
                      .catch((err: Error) => toast(err.message));
                  }}
                >
                  撤销到：{l.label}
                </button>
              ))
            ))}
        </div>
      )}
    </>
  );
}

export const CUSTOM_RENDERERS: Record<string, CustomRenderer> = {
  resetLayout: ResetLayout,
  bgImage: BgImage,
  loadFonts: LoadFonts,
  previewSpotlight: PreviewSpotlight,
  customSound: CustomSound,
  countdownActions: CountdownActions,
  toggleLeaderboard: ToggleLeaderboard,
  quickPresets: QuickPresets,
  bgmFile: BgmFile,
  welcomeImage: WelcomeImage,
  dataTools: DataTools,
  logTools: LogTools,
};
