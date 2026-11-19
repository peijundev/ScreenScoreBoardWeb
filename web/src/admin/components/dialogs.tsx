import { useEffect, useReducer, useRef, useState, type JSX } from 'react';
import DialogShell from './DialogShell';

export interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  /** 允许提交空字符串（用于清空简介等）；关闭时空输入等同取消 */
  allowEmpty?: boolean;
  confirmText?: string;
  cancelText?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type Entry =
  | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | { id: number; kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void };

let seq = 0;
const queue: Entry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function enqueue(entry: Entry): void {
  queue.push(entry);
  emit();
}

function finish(entry: Entry): void {
  const index = queue.indexOf(entry);
  if (index >= 0) queue.splice(index, 1);
  emit();
}

export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    enqueue({ id: ++seq, kind: 'prompt', options, resolve });
  });
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    enqueue({ id: ++seq, kind: 'confirm', options, resolve });
  });
}

function PromptBody({ entry }: { entry: Extract<Entry, { kind: 'prompt' }> }): JSX.Element {
  const [value, setValue] = useState(entry.options.defaultValue || '');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, []);
  const submit = (): void => {
    finish(entry);
    const text = value.trim();
    entry.resolve(text || entry.options.allowEmpty ? text : null);
  };
  return (
    <form
      className="app-dialog-body"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {entry.options.label && <p className="hint">{entry.options.label}</p>}
      {entry.options.multiline ? (
        <textarea
          ref={(node) => { inputRef.current = node; }}
          className="app-dialog-input"
          rows={4}
          value={value}
          placeholder={entry.options.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input
          ref={(node) => { inputRef.current = node; }}
          className="app-dialog-input"
          value={value}
          placeholder={entry.options.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <div className="app-dialog-actions">
        <button
          className="btn"
          type="button"
          onClick={() => {
            finish(entry);
            entry.resolve(null);
          }}
        >
          {entry.options.cancelText || '取消'}
        </button>
        <button className="btn primary" type="submit">
          {entry.options.confirmText || '确定'}
        </button>
      </div>
    </form>
  );
}

function ConfirmBody({ entry }: { entry: Extract<Entry, { kind: 'confirm' }> }): JSX.Element {
  const close = (value: boolean): void => {
    finish(entry);
    entry.resolve(value);
  };
  return (
    <div className="app-dialog-body">
      {entry.options.message && <p className="app-dialog-message">{entry.options.message}</p>}
      <div className="app-dialog-actions">
        <button className="btn" type="button" onClick={() => close(false)}>
          {entry.options.cancelText || '取消'}
        </button>
        <button
          className={'btn' + (entry.options.danger ? ' danger' : ' primary')}
          type="button"
          onClick={() => close(true)}
        >
          {entry.options.confirmText || '确定'}
        </button>
      </div>
    </div>
  );
}

/** 应用内 prompt/confirm 宿主；App 顶层渲染一次即可 */
export function DialogHost(): JSX.Element | null {
  const [, force] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, [force]);
  const entry = queue[0];
  if (!entry) return null;
  const close = (): void => {
    if (entry.kind === 'prompt') entry.resolve(null);
    else entry.resolve(false);
    finish(entry);
  };
  return (
    <DialogShell
      key={entry.id}
      title={entry.options.title}
      storageKey={'dialog-' + entry.kind}
      resizable={false}
      defaultWidth={480}
      defaultHeight={280}
      onClose={close}
    >
      {entry.kind === 'prompt'
        ? <PromptBody entry={entry} />
        : <ConfirmBody entry={entry} />}
    </DialogShell>
  );
}
