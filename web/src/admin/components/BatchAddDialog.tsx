import { useMemo, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { projectOp } from '../../shared/store';
import { toast } from '../../shared/ui';

function parseNames(text: string): { unique: string[]; dup: number } {
  const raw = text
    .split(/[\n\r,，、;；\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  return { unique, dup: raw.length - unique.length };
}

export default function BatchAddDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [teamId, setTeamId] = useState('');
  const teams = useMemo(
    () => Object.values(project.teams).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [project.teams],
  );
  const { unique, dup } = parseNames(text);
  const tooLong = unique.find((n) => Array.from(n).length > 20);

  let preview = '将添加 ' + unique.length + ' 人';
  if (dup > 0) preview += '，批内重复 ' + dup + ' 个已合并';
  if (tooLong) preview += '；存在超过 20 字的姓名：' + tooLong;

  async function submit(): Promise<void> {
    if (!unique.length) {
      toast('请先输入姓名');
      return;
    }
    try {
      const res = await projectOp(project.id, 'addPeopleBatch', { names: unique, teamId: teamId || null });
      const result = res as { added?: number; skipped?: string[] };
      let msg = '已添加 ' + (result.added ?? 0) + ' 人';
      if (result.skipped?.length) msg += '，跳过重名 ' + result.skipped.length + ' 个';
      toast(msg);
      onClose();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: '92vw',
          background: 'var(--card)',
          border: '1px solid var(--card-border)',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>批量添加人员</h2>
          <button className="btn small" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <label>
          名单（换行 / 逗号 / 顿号 / 分号 / 制表符分隔）
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'张三\n李四\n王五'}
          />
        </label>
        <label>
          加入团队
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">无团队</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">{preview}</span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn small" type="button" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" type="button" onClick={() => void submit()}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
