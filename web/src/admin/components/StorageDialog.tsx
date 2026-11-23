import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  getStorageConfig,
  importStorageLibrary,
  migrateStorage,
  storageLibraryExportUrl,
  testStorageConnection,
  updateStorageConfig,
  type LibraryExportFormat,
  type LibraryImportFormat,
  type LibrarySection,
  type StorageBackendDescriptor,
  type StorageFieldDescriptor,
  type StorageFormValue,
  type StorageKind,
  type StorageStatusResponse,
  type StorageTestResult,
} from '../../shared/storage';
import DialogShell from './DialogShell';
import { confirm } from './dialogs';

interface Props {
  onClose: () => void;
}

type Notice = { type: 'ok' | 'warn' | 'error'; text: string };
type Busy = 'test' | 'save' | 'migrate' | 'import' | null;

const LIBRARY_SECTIONS: Array<[LibrarySection, string]> = [
  ['projects', '项目'],
  ['themes', '主题库'],
  ['themeDrafts', '主题草稿'],
];

function sourceLabel(source: string): string {
  if (source === 'storage.json') return 'storage.json';
  if (source === 'env') return '环境变量';
  if (source === 'legacy') return '旧 state.json 自动识别';
  return '默认（SQLite）';
}

function backendDefaults(backend: StorageBackendDescriptor): Record<string, StorageFormValue> {
  const out: Record<string, StorageFormValue> = {};
  for (const field of backend.fields) {
    if (field.default !== undefined) out[field.name] = field.default;
  }
  return out;
}

function formFor(
  backends: StorageBackendDescriptor[],
  config: StorageStatusResponse['config'],
  kind: StorageKind,
): Record<string, StorageFormValue> {
  const backend = backends.find((item) => item.kind === kind);
  if (!backend) return {};
  const out = backendDefaults(backend);
  if (config.kind === kind) {
    for (const field of backend.fields) {
      const value = config.options[field.name];
      if (value !== undefined) out[field.name] = value;
    }
  }
  return out;
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '—';
  }
}

/** 局域网 HTTP 等非安全上下文没有 navigator.clipboard，退回 textarea 复制。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试兼容路径
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 只读路径行：完整路径可选中，旁边提供复制按钮。 */
function LocationRow({ label, value }: { label: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    const ok = await writeClipboard(value);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="storage-location-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
      <button type="button" className="storage-copy" onClick={() => { void copy(); }}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

export default function StorageDialog({ onClose }: Props): JSX.Element {
  const [status, setStatus] = useState<StorageStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<StorageKind>('sqlite');
  const [form, setForm] = useState<Record<string, StorageFormValue>>({});
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [testResult, setTestResult] = useState<StorageTestResult | null>(null);
  const [migrateMode, setMigrateMode] = useState<'copy' | 'empty'>('copy');
  const [overwrite, setOverwrite] = useState(false);
  const [exportFormat, setExportFormat] = useState<LibraryExportFormat>('json');
  const [exportScope, setExportScope] = useState<Record<LibrarySection, boolean>>({
    projects: true,
    themes: true,
    themeDrafts: true,
  });
  const [importFormat, setImportFormat] = useState<LibraryImportFormat>('auto');
  const [importScope, setImportScope] = useState<Record<LibrarySection, boolean>>({
    projects: true,
    themes: true,
    themeDrafts: true,
  });
  const importFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getStorageConfig();
      setStatus(data);
      setKind(data.config.kind);
      setForm(formFor(data.backends, data.config, data.config.kind));
      setClearPassword(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const backend = useMemo(
    () => status?.backends.find((item) => item.kind === kind) || null,
    [status, kind],
  );

  const setField = useCallback((name: string, value: StorageFormValue) => {
    setForm((prev) => ({ ...prev, [name]: value }));
    setTestResult(null);
  }, []);

  const selectKind = useCallback((next: StorageKind) => {
    if (!status) return;
    setKind(next);
    setForm(formFor(status.backends, status.config, next));
    setTestResult(null);
    setClearPassword(false);
    setNotice(null);
  }, [status]);

  const runTest = useCallback(async () => {
    setBusy('test');
    setNotice(null);
    try {
      const result = await testStorageConnection({ kind, options: form });
      setTestResult(result);
      if (result.ok) {
        setNotice({
          type: 'ok',
          text: `连接成功${result.existing ? '，目标已有数据' : '，目标为空'}（${result.latencyMs ?? 0} ms）`,
        });
      } else {
        setNotice({ type: 'error', text: result.message || '连接失败' });
      }
    } catch (err) {
      setNotice({ type: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [kind, form]);

  const runSave = useCallback(async () => {
    const ok = await confirm({
      title: '仅保存存储配置',
      message: '配置保存后需要重启服务才会生效。此操作不会迁移数据，新后端将按自身现有数据启动。',
      confirmText: '保存',
    });
    if (!ok) return;
    setBusy('save');
    setNotice(null);
    try {
      await updateStorageConfig({ kind, options: form, clearPassword });
      setNotice({ type: 'ok', text: '配置已保存，请重启服务后生效。' });
      await load();
    } catch (err) {
      setNotice({ type: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [kind, form, clearPassword, load]);

  const runMigrate = useCallback(async () => {
    const label = backend?.label || kind;
    const ok = await confirm({
      title: migrateMode === 'copy' ? '保存并迁移现有数据' : '保存并切换为空库',
      message: migrateMode === 'copy'
        ? `将当前数据复制到 ${label}，回读校验成功后保存配置。需要重启服务生效；重启前的写入不会同步到新后端。`
        : `新后端 ${label} 将从空库开始，不会复制当前数据。旧后端的数据不会被删除。需要重启服务生效。`,
      danger: migrateMode === 'empty',
      confirmText: migrateMode === 'copy' ? '迁移并保存' : '切换为空库',
    });
    if (!ok) return;
    setBusy('migrate');
    setNotice(null);
    try {
      const result = await migrateStorage({
        mode: migrateMode,
        overwrite,
        clearPassword,
        config: { kind, options: form },
      });
      const bytes = result.bytes ? `（${result.bytes} 字节）` : '';
      setNotice({
        type: 'ok',
        text: migrateMode === 'copy'
          ? `数据已迁移并保存${bytes}。请尽快重启服务；重启前的写入不会同步到新后端。`
          : '配置已保存为新后端空库。请重启服务后生效。',
      });
      await load();
    } catch (err) {
      setNotice({ type: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [backend, kind, migrateMode, overwrite, clearPassword, form, load]);

  const selectedExportScope = LIBRARY_SECTIONS
    .map(([key]) => key)
    .filter((key) => exportScope[key]);
  const selectedImportScope = LIBRARY_SECTIONS
    .map(([key]) => key)
    .filter((key) => importScope[key]);
  const nativeAvailable = Boolean(
    status
      && status.location.active.type === 'file'
      && ['json', 'txt', 'sqlite'].includes(status.active.kind),
  );

  async function runImport(): Promise<void> {
    const file = importFileRef.current?.files?.[0];
    if (!file) {
      setNotice({ type: 'error', text: '请选择要导入的文件' });
      return;
    }
    if (!selectedImportScope.length) {
      setNotice({ type: 'error', text: '请选择导入范围' });
      return;
    }
    const ok = await confirm({
      title: '整库导入',
      message: '将替换所选范围的数据，并清理相关项目的运行态（撤销/倒计时/突显/抢答）。建议先导出备份。确定继续？',
      confirmText: '导入',
      danger: true,
    });
    if (!ok) return;
    setBusy('import');
    setNotice(null);
    try {
      const result = await importStorageLibrary(file, {
        format: importFormat,
        scope: selectedImportScope,
      });
      const counts = result.counts;
      setNotice({
        type: 'ok',
        text: `整库导入完成：项目 ${counts.projects ?? '未选'}、主题 ${counts.themes ?? '未选'}、草稿 ${counts.themeDrafts ?? '未选'}。`,
      });
      if (importFileRef.current) importFileRef.current.value = '';
      await load();
    } catch (err) {
      setNotice({ type: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  function renderField(field: StorageFieldDescriptor): JSX.Element {
    const value = form[field.name];
    const id = 'storage-field-' + field.name;
    if (field.type === 'boolean') {
      return (
        <label className="storage-check" key={field.name} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => setField(field.name, e.target.checked)}
          />
          <span>{field.label}</span>
          {field.help && <em>{field.help}</em>}
        </label>
      );
    }
    if (field.type === 'select') {
      return (
        <label className="storage-field" key={field.name} htmlFor={id}>
          <span>{field.label}</span>
          <select
            id={id}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => setField(field.name, e.target.value)}
          >
            {(field.options || []).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {field.help && <em>{field.help}</em>}
        </label>
      );
    }
    const isPassword = field.type === 'password';
    const savedPassword = isPassword && status?.config.hasPassword === true && status.config.kind === kind;
    const placeholder = isPassword && savedPassword
      ? '已设置，留空保持不变'
      : field.secretUrl
        ? '密码显示为 ***，留空保持原值'
        : field.placeholder || '';
    return (
      <label className="storage-field" key={field.name} htmlFor={id}>
        <span>{field.label}</span>
        <input
          id={id}
          type={isPassword ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          min={field.min}
          max={field.max}
          maxLength={field.maxLength}
          placeholder={placeholder}
          autoComplete={isPassword ? 'new-password' : 'off'}
          onChange={(e) => {
            const raw = e.target.value;
            setField(field.name, field.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
          }}
        />
        {field.help && <em>{field.help}</em>}
      </label>
    );
  }

  return (
    <DialogShell
      title="存储后端"
      storageKey="storageDialog"
      defaultWidth={900}
      defaultHeight={720}
      minWidth={640}
      minHeight={480}
      onClose={onClose}
    >
      <div className="storage-dialog">
        {loading && <p className="hint">正在读取存储配置…</p>}
        {error && <div className="storage-notice error">{error}</div>}

        {status && (
          <>
            <section className="storage-status-card">
              <h3>当前运行中</h3>
              <div className="storage-status-grid">
                <span>后端</span><strong>{status.active.kind}</strong>
                <span>配置来源</span><strong>{sourceLabel(status.active.source)}</strong>
                <span>版本号</span><strong>{String(status.active.revision ?? '—')}</strong>
                <span>连接状态</span>
                <strong className={status.runtime.ok ? 'storage-ok' : 'storage-bad'}>
                  {status.runtime.ok ? '正常' : '异常'}
                </strong>
                <span>最近保存</span><strong>{formatTime(status.active.lastSaveAt)}</strong>
                <span>跨主机锁</span>
                <strong>{status.runtime.lock?.supported ? '支持' : '不支持（仅 CAS）'}</strong>
              </div>
              {status.location && (
                <div className="storage-location">
                  <LocationRow label="数据目录" value={status.location.dataDir} />
                  <LocationRow
                    label="数据位置"
                    value={status.location.active.type === 'remote'
                      ? `远端 · ${status.location.active.detail || status.location.active.path || status.active.kind}`
                      : status.location.active.path || '—'}
                  />
                </div>
              )}
              {status.restartRequired && (
                <div className="storage-restart-banner">
                  配置已保存，重启服务后生效。迁移后到重启之间的写入不会同步到新后端，请尽快重启。
                </div>
              )}
              {status.runtime.conflict && (
                <div className="storage-notice error">
                  检测到外部写入，已停止落盘以避免覆盖新数据；请重启服务或检查是否有另一个实例。
                </div>
              )}
              {(status.runtime.warnings || []).map((warning) => (
                <div className="storage-notice warn" key={warning}>{warning}</div>
              ))}
              {status.active.lastSaveError && status.runtime.ok && (
                <p className="hint">最近保存错误：{status.active.lastSaveError}</p>
              )}
            </section>

            <section>
              <h3>选择后端</h3>
              <div className="storage-backend-grid">
                {status.backends.map((item) => (
                  <button
                    key={item.kind}
                    type="button"
                    className={'storage-backend-card' + (item.kind === kind ? ' active' : '')}
                    onClick={() => selectKind(item.kind)}
                  >
                    <span className="storage-backend-name">
                      {item.label}
                      {item.recommended && <em>{item.recommendedLabel || '推荐'}</em>}
                    </span>
                    <span className="storage-backend-desc">{item.description}</span>
                  </button>
                ))}
              </div>
            </section>

            {backend && (
              <section className="storage-form">
                <h3>{backend.label} 连接参数</h3>
                {backend.recommendedNote && (
                  <div className="storage-notice warn">{backend.recommendedNote}</div>
                )}
                {(backend.pros.length > 0 || backend.cons.length > 0) && (
                  <div className="storage-pros-cons">
                    {backend.pros.length > 0 && (
                      <div className="storage-pros">
                        <strong>优点</strong>
                        <ul>
                          {backend.pros.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                    {backend.cons.length > 0 && (
                      <div className="storage-cons">
                        <strong>缺点</strong>
                        <ul>
                          {backend.cons.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                {backend.warning && (
                  <div className="storage-risk">{backend.warning}</div>
                )}
                {backend.maxSnapshotBytes ? (
                  <div className="storage-risk">
                    该后端单份状态快照上限约 {(backend.maxSnapshotBytes / (1024 * 1024)).toFixed(1)} MB；
                    接近上限时保存与迁移会失败，请精简项目或改用 PostgreSQL 等后端。
                  </div>
                ) : null}
                <div className="storage-fields">
                  {backend.fields.map(renderField)}
                </div>
                {backend.fields.some((field) => field.type === 'password') &&
                  status.config.hasPassword && status.config.kind === kind && (
                    <label className="storage-check">
                      <input
                        type="checkbox"
                        checked={clearPassword}
                        onChange={(e) => setClearPassword(e.target.checked)}
                      />
                      <span>清除已保存的密码或密钥</span>
                    </label>
                  )}

                <div className="storage-actions">
                  <button className="btn" type="button" disabled={busy !== null} onClick={() => { void runTest(); }}>
                    {busy === 'test' ? '测试中…' : '测试连接'}
                  </button>
                  <button className="btn" type="button" disabled={busy !== null} onClick={() => { void runSave(); }}>
                    {busy === 'save' ? '保存中…' : '仅保存配置'}
                  </button>
                </div>

                <div className="storage-migrate">
                  <h4>切换数据</h4>
                  <label className="storage-check">
                    <input
                      type="radio"
                      name="storage-migrate-mode"
                      checked={migrateMode === 'copy'}
                      onChange={() => setMigrateMode('copy')}
                    />
                    <span>迁移现有数据到新后端</span>
                  </label>
                  <label className="storage-check">
                    <input
                      type="radio"
                      name="storage-migrate-mode"
                      checked={migrateMode === 'empty'}
                      onChange={() => setMigrateMode('empty')}
                    />
                    <span>新后端从空库开始</span>
                  </label>
                  <label className="storage-check">
                    <input
                      type="checkbox"
                      checked={overwrite}
                      onChange={(e) => setOverwrite(e.target.checked)}
                    />
                    <span>目标已有数据时覆盖</span>
                  </label>
                  <button
                    className={'btn ' + (migrateMode === 'empty' ? 'danger' : 'primary')}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => { void runMigrate(); }}
                  >
                    {busy === 'migrate'
                      ? '处理中…'
                      : migrateMode === 'copy' ? '保存并迁移现有数据' : '保存并切换为空库'}
                  </button>
                </div>
              </section>
            )}

            <section className="storage-migrate storage-library">
              <h4>整库导出</h4>
              <p className="hint">
                选择要导出的范围与格式；不含账号/令牌、上传资源与运行态。
              </p>
              <div className="storage-library-row">
                {LIBRARY_SECTIONS.map(([key, label]) => (
                  <label className="storage-check" key={key}>
                    <input
                      type="checkbox"
                      checked={exportScope[key]}
                      onChange={(e) => setExportScope((prev) => ({ ...prev, [key]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className="storage-library-row">
                <label className="storage-field">
                  格式
                  <select
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value as LibraryExportFormat)}
                  >
                    <option value="json">JSON</option>
                    <option value="sqlite">SQLite</option>
                    <option value="txt">TXT</option>
                    <option value="native" disabled={!nativeAvailable}>当前后端原生文件</option>
                  </select>
                </label>
                {exportFormat === 'native' ? (
                  nativeAvailable ? (
                    <a
                      className="btn"
                      href={storageLibraryExportUrl('native', selectedExportScope)}
                      download
                    >
                      导出原生文件
                    </a>
                  ) : (
                    <button className="btn" type="button" disabled>原生文件不可用</button>
                  )
                ) : selectedExportScope.length ? (
                  <a
                    className="btn"
                    href={storageLibraryExportUrl(exportFormat, selectedExportScope)}
                    download
                  >
                    导出
                  </a>
                ) : (
                  <button className="btn" type="button" disabled>请选择范围</button>
                )}
              </div>
              {exportFormat === 'native' && (
                <p className="hint">原生文件会导出当前后端的全部数据，忽略上方范围选择；仅支持 JSON / TXT / SQLite 文件后端。</p>
              )}
              {!nativeAvailable && (
                <p className="hint">当前后端不是单文件后端，原生文件导出不可用。</p>
              )}
            </section>

            <section className="storage-migrate storage-library">
              <h4>整库导入</h4>
              <p className="hint">
                支持 JSON / SQLite / TXT 或自动识别。导入会替换所选范围的数据，并清理相关项目的运行态；建议先导出备份。
              </p>
              <div className="storage-library-row">
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json,.txt,.db,.sqlite,.sqlite3,application/json,text/plain,application/vnd.sqlite3"
                  aria-label="选择整库导入文件"
                />
                <label className="storage-field">
                  格式
                  <select
                    value={importFormat}
                    onChange={(e) => setImportFormat(e.target.value as LibraryImportFormat)}
                  >
                    <option value="auto">自动识别</option>
                    <option value="json">JSON</option>
                    <option value="sqlite">SQLite</option>
                    <option value="txt">TXT</option>
                  </select>
                </label>
              </div>
              <div className="storage-library-row">
                {LIBRARY_SECTIONS.map(([key, label]) => (
                  <label className="storage-check" key={key}>
                    <input
                      type="checkbox"
                      checked={importScope[key]}
                      onChange={(e) => setImportScope((prev) => ({ ...prev, [key]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy !== null || !selectedImportScope.length}
                  onClick={() => { void runImport(); }}
                >
                  {busy === 'import' ? '导入中…' : '导入整库'}
                </button>
              </div>
            </section>

            {testResult && (
              <div className={'storage-notice ' + (testResult.ok ? 'ok' : 'error')} aria-live="polite">
                {testResult.ok
                  ? `测试连接成功（${testResult.latencyMs ?? 0} ms）${testResult.existing ? '，目标已有数据' : '，目标为空'}`
                  : `测试连接失败：${testResult.message || testResult.code || '未知错误'}`}
              </div>
            )}
            {notice && (
              <div className={'storage-notice ' + notice.type} aria-live="polite">{notice.text}</div>
            )}
            {testResult?.warnings && testResult.warnings.length > 0 && (
              <div className="storage-notice warn">
                {testResult.warnings.join('；')}
              </div>
            )}

            <p className="hint">
              存储配置保存在 <code>{status.location?.configFile || 'storage.json'}</code>（仅管理员 API 可读），密码不会回传前端。
              保存或迁移后需要重启服务才会生效；切换前请确认已备份 <code>{status.location?.dataDir || 'DATA_DIR'}</code>。
            </p>
          </>
        )}
      </div>
    </DialogShell>
  );
}
