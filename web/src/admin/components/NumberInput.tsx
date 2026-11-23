import { useEffect, useRef, useState, type JSX } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * 滑条配套的数字输入：允许逐字输入，提交时夹紧到范围。
 * 中间态（如输入 1、12 时）不会立刻写入/夹紧，避免无法输入 120。
 */
export default function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  title,
  disabled = false,
}: Props): JSX.Element {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  function clamp(raw: string): number | null {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  function commit(raw: string): void {
    const next = clamp(raw);
    if (next === null) {
      setText(String(value));
      return;
    }
    onChange(next);
    setText(String(next));
  }

  return (
    <input
      type="number"
      className={className}
      min={min}
      max={max}
      step={step}
      value={text}
      disabled={disabled}
      title={title ?? '直接输入数值'}
      onFocus={() => { focused.current = true; }}
      onBlur={(e) => { focused.current = false; commit(e.target.value); }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const next = clamp(raw);
        // 只在输入已是完整合法值时实时同步；中间态等失焦/回车再提交
        if (next !== null && String(next) === raw.trim()) onChange(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(e.currentTarget.value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
