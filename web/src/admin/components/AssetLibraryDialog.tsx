import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Snapshot } from '../../shared/types';
import {
  deleteImageAsset,
  deleteSound,
  listAssets,
  uploadAvatar,
  uploadSound,
  type Asset,
  type AssetList,
} from '../../shared/api';
import { playSoundFile } from '../../shared/sound';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import DialogShell from './DialogShell';
import { confirm } from './dialogs';

/** 构建资源引用表：path → 使用位置描述 */
function buildUsage(snapshot: Snapshot | null): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  if (!snapshot) return usage;
  const add = (key: string | null | undefined, label: string): void => {
    if (!key) return;
    const list = usage.get(key);
    if (list) list.push(label);
    else usage.set(key, [label]);
  };
  for (const project of Object.values(snapshot.projects)) {
    const s = project.settings;
    add(s.bgImage, '「' + project.name + '」背景图');
    add(s.welcomeImage, '「' + project.name + '」欢迎图');
    add(s.customSound, '「' + project.name + '」记分音效');
    add(s.bgmFile, '「' + project.name + '」背景音乐');
    for (const p of Object.values(project.people)) {
      add(p.avatar, '「' + project.name + '」' + p.name + ' 头像');
      add(p.cardImage, '「' + project.name + '」' + p.name + ' 卡片图');
    }
    for (const t of Object.values(project.teams)) {
      add(t.avatar, '「' + project.name + '」' + t.name + ' 头像');
      add(t.cardImage, '「' + project.name + '」' + t.name + ' 卡片图');
    }
  }
  return usage;
}

/** 显示导入时的文件名（同名冲突时服务端会追加 -1、-2） */
function assetLabel(asset: Asset): string {
  return asset.path.split('/').pop() || asset.path;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

export default function AssetLibraryDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot);
  const [assets, setAssets] = useState<AssetList>({ avatars: [], sounds: [] });
  const [busy, setBusy] = useState(false);
  const usage = useMemo(() => buildUsage(snapshot), [snapshot]);

  const reload = useCallback((): void => {
    setBusy(true);
    listAssets()
      .then((list) =>
        setAssets({
          avatars: [...list.avatars].sort((a, b) => b.mtime - a.mtime),
          sounds: [...list.sounds].sort((a, b) => b.mtime - a.mtime),
        }),
      )
      .catch((err: Error) => toast(err.message))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const uploadImage = (file: File): void => {
    setBusy(true);
    uploadAvatar(file)
      .then(() => {
        reload();
        toast('图片已加入资源库');
      })
      .catch((err: Error) => toast(err.message))
      .finally(() => setBusy(false));
  };

  const uploadAudio = (file: File): void => {
    setBusy(true);
    uploadSound(file)
      .then(() => {
        reload();
        toast('音频已加入资源库');
      })
      .catch((err: Error) => toast(err.message))
      .finally(() => setBusy(false));
  };

  const remove = async (kind: 'avatars' | 'sounds', asset: Asset): Promise<void> => {
    const refs = usage.get(asset.path) || [];
    if (refs.length) {
      const shown =
        refs.slice(0, 5).join('、') + (refs.length > 5 ? ' 等 ' + refs.length + ' 处' : '');
      const ok = await confirm({
        title: '资源正在使用中',
        message: shown + '。强制删除会同时移除这些引用。',
        confirmText: '强制删除并移除引用',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
    } else {
      const ok = await confirm({
        title: '删除资源',
        message: '从资源库删除这个文件？',
        confirmText: '删除',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const cleared =
        kind === 'sounds'
          ? await deleteSound(asset.path, true)
          : await deleteImageAsset(asset.path, true);
      toast(cleared > 0 ? '已删除，并移除 ' + cleared + ' 处引用' : '已删除');
      reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usedTag = (path: string): JSX.Element | null => {
    const refs = usage.get(path);
    if (!refs || !refs.length) return null;
    return (
      <span className="asset-used" title={refs.join('\n')}>
        使用中 · {refs.length}
      </span>
    );
  };

  return (
    <DialogShell
      title="资源库"
      storageKey="assetLibraryDialog"
      defaultWidth={860}
      defaultHeight={680}
      onClose={onClose}
    >
      <div className="asset-library">
        <div className="set-group">
          <h3>图片资源（{assets.avatars.length}）</h3>
          <div className="asset-toolbar">
            <label className="file-btn">
              导入图片
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadImage(file);
                  e.target.value = '';
                }}
              />
            </label>
            <button className="btn small" type="button" onClick={reload} disabled={busy}>
              刷新
            </button>
            <span className="hint">头像、卡片图、背景图都在这里；导入后在人员/设置里选择</span>
          </div>
          {assets.avatars.length === 0 ? (
            <p className="asset-empty">还没有导入图片</p>
          ) : (
            <div className="asset-grid">
              {assets.avatars.map((asset) => (
                <div className="asset-card" key={asset.path}>
                  <a href={'/' + asset.path} target="_blank" rel="noreferrer">
                    <img src={'/' + asset.path} alt="" loading="lazy" />
                  </a>
                  <div className="asset-meta">
                    <span className="asset-name" title={asset.path}>
                      {assetLabel(asset)}
                    </span>
                    {usedTag(asset.path)}
                  </div>
                  <div className="asset-actions">
                    <span className="hint">{formatBytes(asset.bytes)}</span>
                    <button
                      className="btn small danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void remove('avatars', asset)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="set-group">
          <h3>音频资源（{assets.sounds.length}）</h3>
          <div className="asset-toolbar">
            <label className="file-btn">
              导入音频
              <input
                type="file"
                accept="audio/wav,audio/ogg,audio/mpeg,audio/mp4,.wav,.ogg,.mp3,.m4a"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadAudio(file);
                  e.target.value = '';
                }}
              />
            </label>
            <span className="hint">音效和背景音乐都在这里；导入后在设置里选择</span>
          </div>
          {assets.sounds.length === 0 ? (
            <p className="asset-empty">还没有导入音频</p>
          ) : (
            <div className="asset-list">
              {assets.sounds.map((asset) => (
                <div className="asset-row" key={asset.path}>
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => playSoundFile(asset.path, 0.6)}
                  >
                    试听
                  </button>
                  <div className="asset-info">
                    <span className="asset-name" title={asset.path}>
                      {assetLabel(asset)}
                    </span>
                    <span className="hint">{formatBytes(asset.bytes)}</span>
                  </div>
                  {usedTag(asset.path)}
                  <button
                    className="btn small danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void remove('sounds', asset)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
