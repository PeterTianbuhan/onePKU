import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// WKWebView's custom tauri: origin cannot reliably start a module Worker.
// PDF.js supports its worker handler in the main context for these origins.
// The calendar is one page; keep this fallback inside the lazy calendar bundle.
import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.min.mjs";
import { useResource, action } from "../lib/api";
import { Button, Empty } from "../components/ui";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
if (location.protocol === "tauri:") {
  (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = {
    WorkerMessageHandler,
  };
}
type CalendarData = { year: string; pdf: string; url: string };
function Document({
  data,
  zoom,
  page,
  onReady,
  onPages,
}: {
  data: CalendarData;
  zoom: number;
  page: number;
  onReady: (v: boolean) => void;
  onPages: (n: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy>();
  const [width, setWidth] = useState(900);
  const [error, setError] = useState("");
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const resize = new ResizeObserver((entries) => {
      const next = entries[0].contentRect.width;
      // 亚像素的变化不重排：画布宽度回头影响内容宽度时，一点点抖动就会被放大成
      // 高频的重渲染循环。
      setWidth((current) => (Math.abs(current - next) < 1 ? current : next));
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    let stopped = false;
    onReady(false);
    setError("");
    setDoc(undefined);
    const bytes = Uint8Array.from(atob(data.pdf), (c) => c.charCodeAt(0));
    const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
    task.promise
      .then((d) => {
        if (!stopped) {
          setDoc(d);
          onPages(d.numPages);
        }
      })
      .catch(() => {
        if (!stopped) setError("校历文件未能显示，请重新获取或打开 PDF 原件");
      });
    return () => {
      stopped = true;
      void task.destroy();
    };
  }, [data.pdf, onReady, onPages]);
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let cancelled = false;
    let render: pdfjs.RenderTask | undefined;
    // 学校的校历通常一页；页数多的年份按当前页渲染。
    void doc
      .getPage(page)
      .then((page) => {
        if (cancelled || !canvas.current) return;
        const original = page.getViewport({ scale: 1 });
        const scale = ((width - 32) / original.width) * zoom;
        const viewport = page.getViewport({ scale });
        const pixel = Math.min(
          window.devicePixelRatio || 1,
          6000 / viewport.width,
          6000 / viewport.height,
        );
        const c = canvas.current;
        c.width = Math.floor(viewport.width * pixel);
        c.height = Math.floor(viewport.height * pixel);
        c.style.width = `${viewport.width}px`;
        c.style.height = `${viewport.height}px`;
        render = page.render({
          canvas: c,
          viewport,
          transform: pixel === 1 ? undefined : [pixel, 0, 0, pixel, 0, 0],
        });
        return render.promise.then(() => {
          if (!cancelled) onReady(true);
        });
      })
      .catch((e) => {
        if (!cancelled && e?.name !== "RenderingCancelledException")
          setError("校历渲染失败，请重新获取");
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, width, zoom, page, onReady]);
  return (
    <div
      className="calendar-viewport"
      ref={container}
      tabIndex={0}
      aria-label="校历图表，可滚动查看"
    >
      <canvas
        ref={canvas}
        aria-label={`${data.year} 学年官方校历，第 ${page} 页`}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export default function Calendar() {
  const [year, setYear] = useState("2026-2027");
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [ready, setReady] = useState(false);
  const [openError, setOpenError] = useState("");
  const q = useResource<CalendarData>({ kind: "calendarPdf", year });
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>校历</h1>
          <p className="page-subtitle">北京大学官方学年校历</p>
        </div>
        <Button
          variant="quiet"
          disabled={!q.data?.data}
          onClick={() => {
            const url = q.data?.data?.url;
            if (url)
              void action({ kind: "openLink", url }).catch(() =>
                setOpenError("PDF 原件未能打开"),
              );
          }}
        >
          打开 PDF 原件
        </Button>
      </header>
      <div className="calendar-controls">
        <label>
          <span className="sr-only">学年</span>
          <select
            aria-label="学年"
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              setZoom(1);
              setPage(1);
              setPages(1);
            }}
          >
            <option>2026-2027</option>
            <option>2025-2026</option>
          </select>
        </label>
        <span className="calendar-control-separator" />
        <button
          className="icon-button"
          aria-label="缩小校历"
          disabled={zoom <= 0.75}
          onClick={() => setZoom((z) => Math.max(0.75, z - 0.25))}
        >
          <Minus size={17} />
        </button>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button
          className="icon-button"
          aria-label="放大校历"
          disabled={zoom >= 3}
          onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
        >
          <Plus size={17} />
        </button>
        <Button variant="quiet" onClick={() => setZoom(1)}>
          <Maximize2 size={15} />
          适合宽度
        </Button>
        {pages > 1 && (
          <>
            <span className="calendar-control-separator" />
            <button
              className="icon-button"
              aria-label="上一页"
              disabled={page <= 1}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span className="zoom-value">
              {page} / {pages}
            </span>
            <button
              className="icon-button"
              aria-label="下一页"
              disabled={page >= pages}
              onClick={() => setPage((n) => Math.min(pages, n + 1))}
            >
              <ChevronRight size={17} />
            </button>
          </>
        )}
        <span className="grow" />
        <span className="subtle">第一、第二学期</span>
        <button
          className="icon-button"
          aria-label="刷新校历"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          <RefreshCw size={16} className={q.isFetching ? "spin" : ""} />
        </button>
      </div>
      {(q.data?.error || q.error) && (
        <div className="resource-error" role="status">
          {q.data?.stale
            ? "更新失败，正在显示已保存的校历。"
            : (q.data?.error?.message ?? q.error?.message)}
        </div>
      )}
      {q.data?.data ? (
        <>
          <Document
            data={q.data.data}
            zoom={zoom}
            page={page}
            onReady={setReady}
            onPages={setPages}
          />
          {!ready && (
            <p className="footnote" role="status">
              正在显示官方校历…
            </p>
          )}
        </>
      ) : q.isFetching ? (
        <div className="calendar-loading">
          <div className="skeleton">
            <i />
            <i />
            <i />
          </div>
          <p>正在获取官方校历</p>
        </div>
      ) : (
        <Empty>校历暂不可用，请刷新重试</Empty>
      )}
      <p className="calendar-caption">
        保留官方原版排版。放大后可横向滚动阅读，假期及教学安排以学校最新公告为准。
      </p>
      {openError && <p role="status">{openError}</p>}
    </>
  );
}
