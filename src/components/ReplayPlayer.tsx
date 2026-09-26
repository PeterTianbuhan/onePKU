import { useEffect, useRef, useState } from "react";
import {
  Maximize,
  Minimize,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { action } from "../lib/api";
import { openBrowser } from "../lib/browser";
import { Button } from "./ui";
import { useReplayFullscreen } from "./useReplayFullscreen";
import { usePlayerControls } from "./usePlayerControls";
import {
  SubtitleControls,
  useReplaySubtitles,
  useSubtitleTrack,
} from "./ReplaySubtitles";

export type Replay = {
  title: string;
  time: string;
  url: string;
  hash_id: string;
};
type CacheStatus = {
  completed: number;
  segments: number;
  bytes: number;
  complete: boolean;
  downloading: boolean;
  message: string;
  offline: boolean;
};
type Playback = {
  id: string;
  url: string;
  duration: number;
  title: string;
  status: CacheStatus;
};
export function playbackTime(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = String(value % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
function savedPosition(key: string) {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
export default function ReplayPlayer({
  course,
  video,
  generation,
  close,
  autoPlay = true,
}: {
  course: string;
  video: Replay;
  generation: string;
  close: () => void;
  autoPlay?: boolean;
}) {
  const element = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const storageKey = `onepku.playback.${generation}.${course}.${video.hash_id}`;
  const position = useRef(savedPosition(storageKey));
  const mediaReady = useRef(false);
  const lastSaved = useRef(0);
  const [playback, setPlayback] = useState<Playback>();
  const subtitles = useReplaySubtitles(playback?.id);
  const subtitleKey = `${storageKey}.subtitles`;
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(() => {
    try {
      return localStorage.getItem(`${subtitleKey}.enabled`) !== "false";
    } catch {
      return true;
    }
  });
  const [subtitleOffset, setSubtitleOffset] = useState(() => {
    try {
      const value = Number(localStorage.getItem(`${subtitleKey}.offset`));
      return Number.isFinite(value) && Math.abs(value) <= 300 ? value : 0;
    } catch {
      return 0;
    }
  });
  useSubtitleTrack(
    element,
    subtitles.data?.document?.cues,
    subtitlesEnabled,
    subtitleOffset,
  );
  useEffect(() => {
    try {
      localStorage.setItem(`${subtitleKey}.enabled`, String(subtitlesEnabled));
      localStorage.setItem(`${subtitleKey}.offset`, String(subtitleOffset));
    } catch {}
  }, [subtitleKey, subtitlesEnabled, subtitleOffset]);
  const [status, setStatus] = useState<CacheStatus>();
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(true);
  const [needsPlay, setNeedsPlay] = useState(false);
  const [retry, setRetry] = useState(0);
  const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [current, setCurrent] = useState(position.current);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const {
    active: isFullscreen,
    toggle: fullscreen,
    native: nativeFullscreen,
  } = useReplayFullscreen(surface, setError);
  const controls = usePlayerControls(isFullscreen);
  function togglePlay() {
    const video = element.current;
    if (!video || !playback) return;
    if (video.paused)
      void video.play().catch(() => setError("未能开始播放，请重试"));
    else video.pause();
  }
  function seekBy(seconds: number) {
    if (element.current && playback)
      element.current.currentTime = Math.max(
        0,
        Math.min(playback.duration, element.current.currentTime + seconds),
      );
  }
  useEffect(() => {
    let live = true;
    let id: string | undefined;
    setPlayback(undefined);
    setStatus(undefined);
    setWaiting(true);
    setError("");
    void action<Playback>({
      kind: "playbackPrepare",
      course,
      video: video.hash_id,
      refresh: retry > 0,
      position: position.current,
    })
      .then(async (p) => {
        id = p.id;
        if (!live) {
          await action({ kind: "playbackClose", id });
          return;
        }
        setPlayback(p);
        setStatus(p.status);
        if (!p.status.complete && !p.status.offline) {
          const next = await action<CacheStatus>({
            kind: "playbackControl",
            id,
            downloading: true,
          });
          if (live) setStatus(next);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e instanceof Error ? e.message : "回放暂时无法连接");
          setWaiting(false);
        }
      });
    return () => {
      live = false;
      if (id) void action({ kind: "playbackClose", id }).catch(() => {});
    };
  }, [course, video.hash_id, retry]);
  useEffect(() => {
    if (!playback) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await action<CacheStatus>({
          kind: "playbackStatus",
          id: playback.id,
        });
        if (live) setStatus(next);
      } catch {
        /* Playback can continue while status is unavailable. */
      }
      if (live) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [playback]);
  useEffect(() => {
    const el = element.current;
    if (!playback || !el) return;
    let live = true;
    let destroy: (() => void) | undefined;
    mediaReady.current = false;
    const startPosition =
      position.current > 0 && position.current < playback.duration - 5
        ? position.current
        : 0;
    setNeedsPlay(false);
    const start = () => {
      if (!live) return;
      if (startPosition > 0) el.currentTime = startPosition;
      mediaReady.current = true;
      el.playbackRate = rate;
      if (autoPlay)
        void el.play().catch(() => {
          if (live) {
            setNeedsPlay(true);
            setWaiting(false);
          }
        });
    };
    el.addEventListener("loadedmetadata", start, { once: true });
    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = playback.url;
      el.load();
    } else {
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (!live) return;
          if (!Hls.isSupported()) {
            setError("当前窗口无法播放此视频，请使用 OnePKU 桌面应用");
            setWaiting(false);
            return;
          }
          const hls = new Hls({
            startPosition,
            maxBufferLength: 60,
            backBufferLength: 30,
            enableWorker: true,
          });
          destroy = () => hls.destroy();
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal && live) {
              setError(
                "播放暂时中断，已缓存的内容仍然保留。重试后会从这里继续。",
              );
              setWaiting(false);
            }
          });
          hls.loadSource(playback.url);
          hls.attachMedia(el);
        })
        .catch(() => {
          if (live) setError("播放器未能加载，请重试");
        });
    }
    return () => {
      live = false;
      if (Number.isFinite(el.currentTime) && el.currentTime > 0)
        position.current = el.currentTime;
      mediaReady.current = false;
      el.removeEventListener("loadedmetadata", start);
      el.pause();
      destroy?.();
      el.removeAttribute("src");
      el.load();
    };
  }, [playback]);
  function remember() {
    const el = element.current;
    if (!el || !mediaReady.current || !Number.isFinite(el.currentTime)) return;
    position.current = el.currentTime;
    setCurrent(el.currentTime);
    if (Math.abs(el.currentTime - lastSaved.current) >= 5 || el.paused) {
      lastSaved.current = el.currentTime;
      try {
        localStorage.setItem(storageKey, String(el.currentTime));
      } catch {
        /* Playback is unaffected. */
      }
    }
  }
  async function changeCache(downloading: boolean) {
    if (!playback) return;
    setBusy(true);
    try {
      setStatus(
        await action<CacheStatus>({
          kind: "playbackControl",
          id: playback.id,
          downloading,
        }),
      );
    } catch {
      setError("缓存状态未能更新，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function clearCache() {
    if (!playback) return;
    setBusy(true);
    element.current?.pause();
    try {
      await action({ kind: "playbackClose", id: playback.id, clear: true });
      close();
    } catch {
      setError("缓存未能清除，请重试");
    } finally {
      setBusy(false);
    }
  }
  const percent = status?.segments
    ? Math.round((status.completed / status.segments) * 1000) / 10
    : 0;
  return (
    <section className="replay-player" aria-label="本地回放播放器">
      <div className="replay-heading">
        <strong>{video.title}</strong>
        <Button variant="quiet" onClick={close} aria-label="关闭播放器">
          <X size={16} />
        </Button>
      </div>
      <div
        className={`replay-frame${nativeFullscreen ? " replay-native-fullscreen" : ""}${controls.visible ? "" : " replay-controls-idle"}`}
        ref={surface}
        onPointerMove={controls.reveal}
        onPointerDown={controls.hold}
        onKeyDownCapture={controls.reveal}
      >
        <div className="replay-surface">
          <video
            ref={element}
            tabIndex={0}
            onClick={togglePlay}
            onKeyDown={(e) => {
              if (
                [" ", "k", "ArrowLeft", "ArrowRight", "m", "f"].includes(e.key)
              ) {
                e.preventDefault();
                if (e.key === " " || e.key === "k") togglePlay();
                else if (e.key === "ArrowLeft") seekBy(-10);
                else if (e.key === "ArrowRight") seekBy(10);
                else if (e.key === "m" && element.current)
                  element.current.muted = !element.current.muted;
                else if (e.key === "f") fullscreen();
              }
            }}
            playsInline
            preload="auto"
            aria-label={`${video.title} 视频`}
            onTimeUpdate={remember}
            onPlay={() => setPaused(false)}
            onPause={() => {
              setPaused(true);
              remember();
            }}
            onVolumeChange={() => {
              if (element.current) {
                setVolume(element.current.volume);
                setMuted(element.current.muted);
              }
            }}
            onEnded={() => {
              setPaused(true);
              position.current = 0;
              try {
                localStorage.removeItem(storageKey);
              } catch {}
            }}
            onWaiting={() => setWaiting(true)}
            onCanPlay={() => setWaiting(false)}
            onPlaying={() => {
              setWaiting(false);
              setNeedsPlay(false);
              setError("");
            }}
            onError={() => {
              if (playback) {
                setWaiting(false);
                setError(
                  "播放暂时中断，已缓存的内容仍然保留。重试后会从这里继续。",
                );
              }
            }}
          />
          {waiting && !error && (
            <div className="replay-loading" role="status">
              {playback ? "正在缓冲…" : "正在连接回放…"}
            </div>
          )}
          {needsPlay && !error && (
            <div className="replay-start">
              <Button
                onClick={() =>
                  void element.current
                    ?.play()
                    .catch(() => setError("未能开始播放，请重试"))
                }
              >
                开始播放
              </Button>
            </div>
          )}
        </div>
        <div className="replay-chrome">
          <div className="replay-timeline">
            <time>{playbackTime(current)}</time>
            <input
              type="range"
              min={0}
              max={playback?.duration || 1}
              step={1}
              value={playback ? current : 0}
              disabled={!playback}
              aria-label="播放进度"
              aria-valuetext={`${playbackTime(current)} / ${playbackTime(playback?.duration || 0)}`}
              style={{
                backgroundImage: `linear-gradient(to right, var(--primary) ${playback ? Math.min(100, Math.max(0, (current / playback.duration) * 100)) : 0}%, var(--border) 0%)`,
              }}
              onChange={(e) => {
                const value = Number(e.target.value);
                setCurrent(value);
                if (element.current) element.current.currentTime = value;
              }}
            />
            <time>{playbackTime(playback?.duration || 0)}</time>
          </div>
          <div className="replay-controls">
            <Button
              variant="quiet"
              disabled={!playback}
              onClick={togglePlay}
              aria-label={paused ? "播放" : "暂停"}
              title={paused ? "播放（空格）" : "暂停（空格）"}
            >
              {paused ? <Play size={18} /> : <Pause size={18} />}
            </Button>
            <Button
              variant="quiet"
              disabled={!playback}
              aria-label="后退 10 秒"
              title="后退 10 秒"
              onClick={() => {
                if (element.current)
                  element.current.currentTime = Math.max(
                    0,
                    element.current.currentTime - 10,
                  );
              }}
            >
              <RotateCcw size={18} />
            </Button>
            <Button
              variant="quiet"
              disabled={!playback}
              aria-label="快进 10 秒"
              title="快进 10 秒"
              onClick={() => {
                if (element.current)
                  element.current.currentTime = Math.min(
                    playback?.duration ?? 0,
                    element.current.currentTime + 10,
                  );
              }}
            >
              <RotateCw size={18} />
            </Button>
            <label>
              <select
                aria-label="播放速度"
                value={rate}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setRate(n);
                  if (element.current) element.current.playbackRate = n;
                }}
              >
                {[0.75, 1, 1.25, 1.5, 1.75, 2].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
            <div className="replay-volume">
              <Button
                variant="quiet"
                disabled={!playback}
                onClick={() => {
                  if (element.current)
                    element.current.muted = !element.current.muted;
                }}
                aria-label={muted ? "取消静音" : "静音"}
              >
                {muted || volume === 0 ? (
                  <VolumeX size={18} />
                ) : (
                  <Volume2 size={18} />
                )}
              </Button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                disabled={!playback}
                aria-label="音量"
                aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
                onChange={(e) => {
                  if (element.current) {
                    element.current.volume = Number(e.target.value);
                    element.current.muted = false;
                  }
                }}
              />
            </div>
            <Button
              variant="quiet"
              disabled={!playback}
              onClick={fullscreen}
              aria-label={isFullscreen ? "退出全屏" : "全屏"}
              title={isFullscreen ? "退出全屏" : "全屏"}
            >
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </Button>
            <Button
              variant="quiet"
              className="replay-more"
              aria-label="更多播放选项"
              aria-expanded={optionsOpen}
              aria-controls="replay-options"
              onClick={() => setOptionsOpen(!optionsOpen)}
              title="更多播放选项"
            >
              {status && (
                <span>
                  {status.complete
                    ? "已缓存"
                    : status.offline
                      ? "离线缓存"
                      : status.message
                        ? "缓存中断"
                        : `缓存 ${percent}%`}
                </span>
              )}
              <MoreHorizontal size={18} />
            </Button>
          </div>
          <SubtitleControls
            id={playback?.id}
            state={subtitles}
            enabled={subtitlesEnabled}
            setEnabled={setSubtitlesEnabled}
            offset={subtitleOffset}
            setOffset={setSubtitleOffset}
          />
          {optionsOpen && (
            <div id="replay-options" className="replay-options">
              {status && (
                <div className="replay-cache">
                  <div className="replay-cache-line">
                    <span>
                      {status.complete
                        ? "整节已缓存，可离线播放"
                        : `已缓存 ${percent}%（${status.completed} / ${status.segments} 个分片）`}{" "}
                      · {(status.bytes / 1024 / 1024).toFixed(1)} MB
                    </span>
                    {!status.complete && (
                      <Button
                        variant="quiet"
                        disabled={busy || status.offline}
                        onClick={() => void changeCache(!status.downloading)}
                      >
                        {status.downloading ? "暂停整节缓存" : "继续缓存整节"}
                      </Button>
                    )}
                  </div>
                  <progress
                    value={status.completed}
                    max={Math.max(status.segments, 1)}
                    aria-label="回放缓存进度"
                  />
                  {status.message && <p role="status">{status.message}</p>}
                  {status.offline && !status.complete && (
                    <p role="status">
                      当前使用已有缓存；连接恢复后点“重试连接”继续下载。
                    </p>
                  )}
                </div>
              )}
              <div className="replay-footer">
                <div>
                  <button
                    className="text-button"
                    onClick={() =>
                      void openBrowser(video.url, "课程回放原站").catch(() =>
                        setError("原文窗口未能打开"),
                      )
                    }
                  >
                    回放原页
                  </button>
                  <button
                    className="text-button"
                    disabled={!playback || busy}
                    onClick={() => void clearCache()}
                  >
                    清除此回放缓存
                  </button>
                </div>
              </div>
            </div>
          )}
          {(error || (status?.offline && !status.complete)) && (
            <div className="replay-error" role="alert">
              <span>{error || "当前仅能播放已缓存的部分"}</span>
              <Button onClick={() => setRetry((v) => v + 1)}>重试连接</Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
