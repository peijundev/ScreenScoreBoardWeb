import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { CountdownRuntime, Settings } from '../../shared/types';
import { formatDuration, hexToRgba, pad2, prefersReducedMotion } from '../lib/core';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Clock({ settings }: { settings: Settings }): JSX.Element | null {
  const now = useNow(500);
  if (!settings.featureClock) return null;
  const date = new Date(now);
  let hours = date.getHours();
  const suffix = settings.clockFormat === '12' ? (hours >= 12 ? ' PM' : ' AM') : '';
  if (settings.clockFormat === '12') hours = hours % 12 || 12;
  let text = pad2(hours) + ':' + pad2(date.getMinutes());
  if (settings.clockShowSeconds) text += ':' + pad2(date.getSeconds());
  text += suffix;
  if (settings.clockShowDate) {
    text = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + '  ' + text;
  }
  return <div className={'overlay-clock clock-pos-' + settings.clockPosition}>{text}</div>;
}

interface CountdownProps {
  settings: Settings;
  countdown: CountdownRuntime | null;
  offsetMs: number;
  /** 抢答期间即使 featureCountdown 关闭也临时显示，并在归零时立即隐藏。 */
  force?: boolean;
  /** 倒计时结束后保留计时器并显示该提示（抢答准备阶段）。 */
  prompt?: string;
}

function panelStyle(settings: Settings): CSSProperties {
  const bgMode = settings.countdownBgMode || 'theme';
  const themeCard = settings.theme === 'light' ? '#ffffff' : '#1a1f26';
  const style: Record<string, string> = { ['--cd-blur' as string]: (Number(settings.countdownBlur) || 0) + 'px' };
  if (bgMode !== 'theme') {
    const baseBg = settings.countdownBg || themeCard;
    const opacity = bgMode === 'translucent' || bgMode === 'acrylic' ? settings.countdownOpacity : 1;
    style['--cd-panel-bg'] = hexToRgba(baseBg, opacity);
  }
  return style as CSSProperties;
}

export function Countdown({
  settings,
  countdown,
  offsetMs,
  force = false,
  prompt,
}: CountdownProps): JSX.Element | null {
  const now = useNow(250);
  if (!countdown && !prompt) return null;
  if (!force && !settings.featureCountdown) return null;

  const running = countdown?.state === 'running';
  const remaining = countdown
    ? (running
      ? Math.max(0, (countdown.endsAt ?? 0) - (now + offsetMs)) / 1000
      : (countdown.remainingMs ?? 0) / 1000)
    : 0;
  const ended = Boolean(countdown) && (countdown?.state === 'ended' || remaining <= 0);
  // 抢答计时结束立即隐藏「时间到」；若配置了开始提示则改为显示提示
  if (!prompt && force && ended) return null;
  const mode = settings.countdownDisplayMode || 'corner';

  if (mode === 'corner') {
    const both = settings.featureClock;
    const manualSize = Number(settings.countdownFontSize) || 0;
    const style = panelStyle(settings);
    return (
      <div
        className={
          'overlay-countdown clock-pos-' +
          settings.clockPosition +
          (ended && !prompt ? ' ended' : '') +
          (both ? ' shifted' : '') +
          (prompt ? ' is-buzz-start' : '')
        }
        data-bg-mode={String(settings.countdownBgMode || 'theme')}
        style={{ ...style, ['--cd-corner-size' as string]: manualSize > 0 ? manualSize + 'px' : '' }}
      >
        {prompt || (ended ? '时间到' : formatDuration(remaining))}
      </div>
    );
  }

  const shape = settings.countdownShape || 'circle';
  const cdWidth = Number(settings.countdownSize) || 520;
  const canResize = shape === 'rounded' || shape === 'rounded-rect' || shape === 'rect';
  const cdHeight = canResize && Number(settings.countdownHeight) > 0 ? Number(settings.countdownHeight) : cdWidth;
  const manualSize = Number(settings.countdownFontSize) || 0;
  const timeSize = manualSize > 0 ? manualSize : Math.min(180, Math.max(30, Math.round(Math.min(cdWidth, cdHeight) * 0.22)));
  const duration = Math.max(1, ((countdown?.durationMs || 1000) / 1000));
  const progress = prompt ? 1 : Math.max(0, Math.min(1, remaining / duration));
  const text = prompt || (ended ? '时间到' : formatDuration(remaining));
  const caption = prompt ? '第一个按下的队员获胜' : (ended ? '时间到' : '倒计时');
  const style: Record<string, string> = {
    '--cd-size': cdWidth + 'px',
    '--cd-height': cdHeight + 'px',
    '--cd-time-size': timeSize + 'px',
    '--cd-radius': settings.countdownRadius + 'px',
    '--cd-progress': String(progress),
  };
  if (settings.countdownTextColor) style['--cd-text'] = settings.countdownTextColor;
  if (manualSize > 0) style['--ink-num-size'] = manualSize + 'px';
  const panel = panelStyle(settings);

  return (
    <div
      className={
        'countdown-big ' +
        (mode === 'fullscreen' ? 'fullscreen-mode' : 'center-mode') +
        (ended && !prompt ? ' ended' : '') +
        (prompt ? ' is-buzz-start' : '') +
        (settings.countdownShowProgress === false || prompt ? ' no-progress' : '') +
        (settings.countdownShowBackdrop === false ? ' no-backdrop' : '')
      }
      data-shape={shape}
      data-position={settings.countdownPosition || 'center'}
      data-theme={settings.countdownTheme || 'classic'}
      data-bg-mode={String(settings.countdownBgMode || 'theme')}
      style={{ ...(style as CSSProperties), ...panel }}
    >
      {settings.countdownTheme === 'ink' && <InkScene text={text} settings={settings} />}
      {settings.countdownTheme === 'video' && !prompt && countdown && (
        <VideoScene countdown={countdown} remaining={remaining} ended={ended} settings={settings} />
      )}
      <div className="countdown-stage">
        <div className="countdown-ring">
          <div className="countdown-time">{text}</div>
        </div>
        <div className="countdown-caption">{caption}</div>
      </div>
    </div>
  );
}

function InkScene({ text, settings }: { text: string; settings: Settings }): JSX.Element {
  const petals = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => {
        const sprite = 1 + (i % 3);
        return {
          key: i,
          style: {
            left: (Math.random() * 100).toFixed(1) + '%',
            width: (14 + Math.random() * 26).toFixed(0) + 'px',
            backgroundImage: 'url(/img/petal' + sprite + '.png)',
            animationDuration: (7 + Math.random() * 9).toFixed(1) + 's',
            animationDelay: (Math.random() * 10).toFixed(1) + 's',
            '--sway': (30 + Math.random() * 90).toFixed(0) + 'px',
            '--rot': (-40 + Math.random() * 80).toFixed(0) + 'deg',
          } as CSSProperties,
        };
      }),
    [],
  );
  return (
    <div className="ink-scene" aria-hidden="true">
      <div className="ink-art">
        <div className="ink-number" style={{ fontSize: Number(settings.countdownFontSize) > 0 ? undefined : undefined }}>
          {text}
        </div>
      </div>
      <div className="ink-petals">
        {petals.map((p) => (
          <i key={p.key} style={p.style} />
        ))}
      </div>
    </div>
  );
}

function VideoScene({
  countdown,
  remaining,
  ended,
  settings,
}: {
  countdown: CountdownRuntime;
  remaining: number;
  ended: boolean;
  settings: Settings;
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const totalSec = Math.max(1, (countdown.durationMs || 10000) / 1000);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const duration = video.duration || 10.1;
    const rate = Math.min(4, Math.max(0.25, duration / totalSec));
    video.playbackRate = rate;
    const shouldPlay = countdown.state === 'running' && !ended && !prefersReducedMotion(settings);
    if (shouldPlay) {
      if (video.paused) {
        const played = Math.max(0, Math.min(1, 1 - remaining / totalSec));
        if (Math.abs(video.currentTime / duration - played) > 0.08) video.currentTime = played * duration;
        void video.play().catch(() => {});
      }
    } else if (!video.paused) {
      video.pause();
    }
  }, [countdown.state, ended, remaining, totalSec]);

  return (
    <>
      <video ref={ref} className="countdown-video" muted playsInline preload="auto" src="/media/ink-countdown.mp4" />
      <div className={'countdown-video-time' + (ended ? ' ended' : '')}>
        {ended ? '时间到' : formatDuration(remaining)}
      </div>
    </>
  );
}

export function Marquee({ settings }: { settings: Settings }): JSX.Element | null {
  if (!settings.featureMarquee || !settings.marqueeText) return null;
  const style: Record<string, string> = {
    '--marquee-font': settings.marqueeFontSize ? settings.marqueeFontSize + 'px' : '',
    '--marquee-speed': (settings.marqueeSpeed || 1) * 18 + 's',
    '--marquee-color': settings.marqueeColor || '',
    '--marquee-bg': settings.marqueeBgColor || '',
  };
  return (
    <div
      id="marquee"
      className="marquee"
      data-position={settings.marqueePosition || 'top'}
      data-effect={settings.marqueeEffect || 'scroll'}
      style={style as CSSProperties}
    >
      <span>{settings.marqueeText}</span>
    </div>
  );
}
