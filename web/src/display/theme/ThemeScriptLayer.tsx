import { useEffect, useRef, useState, type JSX } from 'react';
import type { Project, RuntimeSnapshot, Settings } from '../../shared/types';
import type { ThemeV2 } from '../../shared/theme';
import {
  buildThemeScriptContext, safeScriptEntry, sanitizeThemeScriptCommands,
  type ThemeScriptCommand,
} from './script';
import { SANDBOX_HTML } from './sandbox-source';

function CommandShape({ command }: { command: ThemeScriptCommand }): JSX.Element {
  switch (command.op) {
    case 'rect':
      return (
        <rect
          x={command.x} y={command.y} width={command.w} height={command.h}
          rx={command.rx || undefined}
          fill={command.fill} stroke={command.stroke}
          strokeWidth={command.strokeWidth || undefined}
          opacity={command.opacity}
        />
      );
    case 'ellipse':
      return (
        <ellipse
          cx={command.x + command.w / 2} cy={command.y + command.h / 2}
          rx={command.w / 2} ry={command.h / 2}
          fill={command.fill} stroke={command.stroke}
          strokeWidth={command.strokeWidth || undefined}
          opacity={command.opacity}
        />
      );
    case 'line':
      return (
        <line
          x1={command.x1} y1={command.y1} x2={command.x2} y2={command.y2}
          stroke={command.stroke} strokeWidth={command.strokeWidth}
          strokeLinecap="round" opacity={command.opacity}
        />
      );
    case 'text':
      return (
        <text
          x={command.x} y={command.y} fill={command.color}
          fontSize={command.size} fontWeight={command.weight}
          fontFamily={command.font === 'system' ? undefined : command.font}
          textAnchor={command.align === 'left' ? 'start' : command.align === 'right' ? 'end' : 'middle'}
          dominantBaseline="central" opacity={command.opacity}
        >
          {command.text}
        </text>
      );
    case 'path':
      return (
        <path
          d={command.d} fill={command.fill} stroke={command.stroke}
          strokeWidth={command.strokeWidth || undefined}
          opacity={command.opacity}
        />
      );
    case 'polygon':
      return (
        <polygon
          points={command.points} fill={command.fill} stroke={command.stroke}
          strokeWidth={command.strokeWidth || undefined}
          opacity={command.opacity}
        />
      );
    default:
      return <></>;
  }
}

/**
 * 主题脚本沙箱。
 *
 * 隔离边界：
 * - iframe 使用 sandbox="allow-scripts"（没有 allow-same-origin，因此是不透明源）；
 * - iframe 内 CSP 关闭网络、图片、表单和导航；
 * - 用户脚本只在专用 Worker 中执行，超时由 iframe 终止 Worker；
 * - 只接受白名单 SVG 绘制指令，非法指令在 iframe 与父页面各校验一次。
 *
 * 主题脚本默认关闭，必须同时在项目设置里开启“主题脚本”才会运行。
 */
export default function ThemeScriptLayer({
  theme,
  project,
  settings,
  runtime,
}: {
  theme: ThemeV2 | null;
  project: Project;
  settings: Settings;
  runtime: RuntimeSnapshot | null;
}): JSX.Element | null {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const runIdRef = useRef(0);
  const acceptedIdRef = useRef(0);
  const frameNoRef = useRef(0);
  const failUntilRef = useRef(0);
  const latestRef = useRef({ project, settings, runtime });
  latestRef.current = { project, settings, runtime };
  const [commands, setCommands] = useState<ThemeScriptCommand[]>([]);
  const [epoch, setEpoch] = useState(0);

  const script = theme?.script;
  const source = typeof script?.source === 'string' ? script.source.slice(0, 32768) : '';
  const entry = safeScriptEntry(script?.entry);
  const active = Boolean(
    theme && script?.enabled === true && source.trim() && settings.themeScriptEnabled === true,
  );
  const width = Number(theme?.canvas?.width) || 1920;
  const height = Number(theme?.canvas?.height) || 1080;
  const fps = Math.max(1, Math.min(30, Number(settings.themeScriptFps) || 8));
  const timeoutMs = Math.max(20, Math.min(500, Number(settings.themeScriptTimeoutMs) || 120));

  useEffect(() => {
    if (!active) {
      setCommands([]);
      return;
    }
    let disposed = false;
    acceptedIdRef.current = 0;
    runIdRef.current = 0;
    const tick = (): void => {
      if (disposed || Date.now() < failUntilRef.current) return;
      const frame = frameRef.current;
      if (!frame?.contentWindow || !readyRef.current) return;
      const { project: currentProject, settings: currentSettings, runtime: currentRuntime } = latestRef.current;
      runIdRef.current += 1;
      // iframe 是不透明源（origin=null），targetOrigin 只能为 '*'；
      // 安全性依赖事件来源校验、沙箱隔离与父侧指令白名单，不能改成具体 origin。
      frame.contentWindow.postMessage({
        type: 'theme-script-run',
        id: 'r' + runIdRef.current,
        source,
        entry,
        timeoutMs,
        ctx: buildThemeScriptContext({
          project: currentProject,
          settings: currentSettings,
          runtime: currentRuntime,
          countdown: currentRuntime?.countdowns?.[currentProject.id] ?? null,
          t: performance.now() / 1000,
          frame: frameNoRef.current++,
          width,
          height,
        }),
      }, '*');
    };
    tick();
    const interval = window.setInterval(tick, Math.max(33, Math.round(1000 / fps)));
    return () => {
      disposed = true;
      window.clearInterval(interval);
      setCommands([]);
    };
  }, [active, source, entry, fps, timeoutMs, width, height, epoch]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!active) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== 'theme-script-result') return;
      const match = /^r(\d+)$/.exec(String(data.id));
      const id = match ? Number(match[1]) : 0;
      if (!id || id <= acceptedIdRef.current) return;
      acceptedIdRef.current = id;
      if (data.ok) {
        setCommands(sanitizeThemeScriptCommands(data.commands));
      } else {
        setCommands([]);
        failUntilRef.current = Date.now() + Math.max(300, timeoutMs * 3);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [active, width, height, timeoutMs]);

  if (!active) return null;

  return (
    <>
      <iframe
        ref={frameRef}
        className="theme-script-sandbox"
        title="主题脚本沙箱"
        sandbox="allow-scripts"
        srcDoc={SANDBOX_HTML}
        tabIndex={-1}
        aria-hidden="true"
        onLoad={() => {
          readyRef.current = true;
          setEpoch((value) => value + 1);
        }}
      />
      <svg
        className="theme-canvas theme-script-canvas"
        viewBox={'0 0 ' + width + ' ' + height}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        {commands.map((command, index) => (
          <CommandShape key={index} command={command} />
        ))}
      </svg>
    </>
  );
}
