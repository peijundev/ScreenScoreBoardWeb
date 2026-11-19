import type { JSX } from 'react';
import type { ThemeNode } from './theme';

function imageHref(src: string): string {
  if (!src) return '';
  if (/^(data:|https?:|\/)/.test(src)) return src;
  return '/' + src;
}

function fontStack(family: string): string {
  if (!family || family === 'system') return 'inherit';
  if (family === 'serif') return 'serif';
  if (family === 'kai') return '"KaiTi", "STKaiti", serif';
  return family;
}

export function pathData(node: ThemeNode): string {
  const pts = node.points;
  if (!pts.length) return '';
  const ox = node.x;
  const oy = node.y;
  const p = (n: number) => Math.round(n * 100) / 100;
  const x = (n: number) => p(ox + n);
  const y = (n: number) => p(oy + n);
  let d = `M ${x(pts[0].x)} ${y(pts[0].y)}`;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    d += ` C ${x(a.x + a.out.x)} ${y(a.y + a.out.y)} ${x(b.x + b.in.x)} ${y(b.y + b.in.y)} ${x(b.x)} ${y(b.y)}`;
  }
  if (node.closed && pts.length > 1) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    d += ` C ${x(a.x + a.out.x)} ${y(a.y + a.out.y)} ${x(b.x + b.in.x)} ${y(b.y + b.in.y)} ${x(b.x)} ${y(b.y)} Z`;
  }
  return d;
}

/** 纯 SVG 节点渲染：只接受已归一化的 ThemeNode，不注入 HTML/外链。 */
export function ThemeNodeShape({ node }: { node: ThemeNode }): JSX.Element | null {
  if (node.visible === false) return null;
  const common = {
    opacity: node.opacity,
    fill: node.type === 'line' ? 'none' : node.fill,
    fillOpacity: node.fillOpacity,
    stroke: node.stroke,
    strokeWidth: node.strokeWidth,
  };
  const rotate = node.rotation
    ? `rotate(${node.rotation} ${node.x + node.w / 2} ${node.y + node.h / 2})`
    : undefined;

  switch (node.type) {
    case 'rect':
      return (
        <rect
          x={node.x} y={node.y} width={node.w} height={node.h}
          rx={node.radius} ry={node.radius}
          transform={rotate} {...common}
        />
      );
    case 'ellipse':
      return (
        <ellipse
          cx={node.x + node.w / 2} cy={node.y + node.h / 2}
          rx={Math.abs(node.w / 2)} ry={Math.abs(node.h / 2)}
          transform={rotate} {...common}
        />
      );
    case 'line':
      return (
        <line
          x1={node.x} y1={node.y} x2={node.x + node.w} y2={node.y + node.h}
          transform={rotate} opacity={node.opacity}
          stroke={node.stroke} strokeWidth={node.strokeWidth}
        />
      );
    case 'text': {
      const anchor = node.textAlign === 'left' ? 'start' : node.textAlign === 'right' ? 'end' : 'middle';
      const tx = node.textAlign === 'left' ? node.x : node.textAlign === 'right' ? node.x + node.w : node.x + node.w / 2;
      return (
        <text
          x={tx} y={node.y + node.h / 2}
          fill={node.fill} fillOpacity={node.fillOpacity} opacity={node.opacity}
          fontSize={node.fontSize} fontWeight={node.fontWeight} fontStyle={node.fontStyle}
          fontFamily={fontStack(node.fontFamily)} textAnchor={anchor} dominantBaseline="middle"
          transform={rotate}
        >
          {node.text}
        </text>
      );
    }
    case 'image':
      return (
        <image
          x={node.x} y={node.y} width={node.w} height={node.h}
          opacity={node.opacity} transform={rotate}
          href={imageHref(node.src)} preserveAspectRatio="xMidYMid slice"
        />
      );
    case 'path':
      return (
        <path
          d={pathData(node)} transform={rotate}
          fill={node.closed ? node.fill : 'none'}
          fillOpacity={node.fillOpacity}
          stroke={node.stroke === 'none' && !node.closed ? (node.fill === 'none' ? '#ffffff' : node.fill) : node.stroke}
          strokeWidth={node.strokeWidth || 1}
          opacity={node.opacity}
          strokeLinecap="round" strokeLinejoin="round"
        />
      );
    default:
      return null;
  }
}
