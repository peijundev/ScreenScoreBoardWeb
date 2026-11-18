import type { JSX } from 'react';
import type { Field } from './types';
import type { Ctx } from './types';
import { CUSTOM_RENDERERS } from './custom';

function rangeText(f: Extract<Field, { t: 'range' }>, value: number): string {
  if (f.fmt === 'pct') return Math.round(value * 100) + (f.unit ?? '');
  if (f.fmt === 'auto') return (value === 0 ? '自动' : String(value)) + (f.unit ?? '');
  if (f.fmt === 'x') return String(Math.round(value * 100) / 100) + (f.unit ?? '');
  return String(value) + (f.unit ?? '');
}

export default function FieldControl({ field, ctx }: { field: Field; ctx: Ctx }): JSX.Element {
  const { settings, set } = ctx;
  const disabled = 'disabled' in field && field.disabled ? field.disabled(settings) : false;

  switch (field.t) {
    case 'range': {
      const value = Number(settings[field.k] ?? field.min);
      return (
        <label>
          {field.label} <span>{rangeText(field, value)}</span>
          <input
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={value}
            disabled={disabled}
            onChange={(e) => set(field.k, Number(e.target.value))}
          />
        </label>
      );
    }
    case 'num': {
      const value = Number(settings[field.k] ?? 0);
      return (
        <label>
          {field.label}
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={1}
            value={Number.isFinite(value) ? value : 0}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) set(field.k, n);
            }}
          />
        </label>
      );
    }
    case 'select': {
      const value = String(settings[field.k] ?? '');
      return (
        <label>
          {field.label}
          <select value={value} disabled={disabled} onChange={(e) => set(field.k, e.target.value, true)}>
            {field.opts.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case 'check': {
      return (
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(settings[field.k])}
            disabled={disabled}
            onChange={(e) => set(field.k, e.target.checked, true)}
          />
          {field.label}
        </label>
      );
    }
    case 'checkValue': {
      const checked = String(settings[field.k] ?? field.off) === field.on;
      return (
        <label className="check">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => set(field.k, e.target.checked ? field.on : field.off, true)}
          />
          {field.label}
        </label>
      );
    }
    case 'text': {
      const value = String(settings[field.k] ?? '');
      return (
        <label>
          {field.label}
          <input
            type="text"
            maxLength={field.max}
            placeholder={field.placeholder}
            value={value}
            onChange={(e) => set(field.k, e.target.value)}
          />
        </label>
      );
    }
    case 'color': {
      const value = String(settings[field.k] || '#000000');
      return (
        <label>
          {field.label}
          <input
            type="color"
            value={value}
            disabled={disabled}
            onChange={(e) => set(field.k, e.target.value, true)}
          />
        </label>
      );
    }
    case 'colorToggle': {
      const raw = String(settings[field.k] ?? '');
      const fallback = field.fallback ? field.fallback(settings) : String(settings.accent ?? '#e8a33d');
      const enabled = Boolean(raw);
      return (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={disabled}
              onChange={(e) => set(field.k, e.target.checked ? (raw || fallback) : '', true)}
            />
            {field.label}
          </label>
          <label>
            颜色
            <input
              type="color"
              value={raw || fallback}
              disabled={disabled || !enabled}
              onChange={(e) => set(field.k, e.target.value, true)}
            />
          </label>
        </>
      );
    }
    case 'font': {
      const value = String(settings[field.k] || 'auto');
      const custom = String(settings[field.ck] ?? '');
      return (
        <>
          <label>
            {field.label}
            <select
              value={value}
              onChange={(e) => set(field.k, e.target.value, true)}
            >
              <option value="auto">跟随全局字体</option>
              <option value="system">系统黑体</option>
              <option value="serif">宋体 / 衬线</option>
              <option value="kai">楷体</option>
              <option value="custom">自定义系统字体</option>
            </select>
          </label>
          <label>
            {field.customLabel}
            <input
              type="text"
              maxLength={60}
              list="system-font-list"
              value={custom}
              disabled={value !== 'custom'}
              onChange={(e) => set(field.ck, e.target.value)}
            />
          </label>
        </>
      );
    }
    case 'custom': {
      const render = CUSTOM_RENDERERS[field.id];
      return render ? render(ctx) : <span />;
    }
  }
}
