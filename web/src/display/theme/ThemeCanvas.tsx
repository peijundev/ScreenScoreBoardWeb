import type { JSX } from 'react';
import type { CountdownRuntime, Project, Settings } from '../../shared/types';
import type { ThemeV2 } from '../../shared/theme';
import { ThemeNodeShape } from '../../shared/theme-render';
import { WidgetView, type WidgetContext } from './widgets';

function imageHref(src: string): string {
  if (!src) return '';
  if (/^(data:|https?:|\/)/.test(src)) return src;
  return '/' + src;
}

/** 主题矢量场景层：固定覆盖视口，位于卡片之下，不拦截交互。 */
export default function ThemeCanvas({
  theme,
  project,
  settings,
  countdown,
}: {
  theme: ThemeV2 | null;
  project: Project;
  settings: Settings;
  countdown: CountdownRuntime | null;
}): JSX.Element | null {
  if (!theme) return null;
  const { canvas, layers } = theme;
  const bg = canvas.background;
  const widgets = theme.widgets.filter((w) => w.surface === 'canvas' && w.visible !== false);
  if (!layers.length && bg.type === 'none' && !widgets.length) return null;
  const ctx: WidgetContext = {
    project, settings, entity: null, entityKind: null, rank: null,
    total: 0, maxAbs: 1, memberCount: 0, countdown, now: Date.now(),
  };
  return (
    <svg
      className="theme-canvas"
      viewBox={'0 0 ' + canvas.width + ' ' + canvas.height}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {bg.type === 'color' && (
        <rect x={0} y={0} width={canvas.width} height={canvas.height} fill={bg.color} />
      )}
      {bg.type === 'image' && bg.image && (
        <image
          x={0} y={0} width={canvas.width} height={canvas.height}
          href={imageHref(bg.image)} preserveAspectRatio="xMidYMid slice"
        />
      )}
      {widgets.map((widget) => (
        <foreignObject
          key={widget.id}
          x={widget.x}
          y={widget.y}
          width={Math.max(8, widget.w)}
          height={Math.max(8, widget.h)}
        >
          <div className="theme-widget-host">
            <WidgetView widget={widget} ctx={ctx} />
          </div>
        </foreignObject>
      ))}
      {layers.map((layer) => {
        if (layer.visible === false) return null;
        const transform = [
          `translate(${layer.x} ${layer.y})`,
          layer.rotation ? `rotate(${layer.rotation})` : '',
          layer.scaleX !== 1 || layer.scaleY !== 1 ? `scale(${layer.scaleX} ${layer.scaleY})` : '',
        ].filter(Boolean).join(' ');
        return (
          <g
            key={layer.id}
            opacity={layer.opacity}
            style={{ mixBlendMode: layer.blendMode }}
            transform={transform || undefined}
          >
            {layer.nodes.map((node) => <ThemeNodeShape key={node.id} node={node} />)}
          </g>
        );
      })}
    </svg>
  );
}
