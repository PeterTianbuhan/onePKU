import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { action, call } from "../lib/api";
import { loadPdf } from "../lib/materialPdf";
import { planIndexMeta, type Plan } from "../lib/curriculum";
import { Button, Modal } from "../components/ui";

type Pages = { pdf: string; path: string; pages: number; volume: string };

/** 培养方案原文：从教务部整卷 PDF 抽出该专业所在的几页，应用内预览，也可用系统预览打开。 */
export default function CurriculumSource({
  plan,
  open,
  onClose,
}: {
  plan: Plan;
  open: boolean;
  onClose: () => void;
}) {
  const { source } = plan;
  const range =
    source.pageStart && source.pageEnd
      ? { from: source.pageStart, to: source.pageEnd }
      : null;
  const [data, setData] = useState<Pages | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!open || !range) return;
    let stopped = false;
    let task: ReturnType<typeof loadPdf> | undefined;
    setError("");
    void call<Pages>({
      kind: "curriculumPages",
      volume: source.volumeId,
      from: range.from,
      to: range.to,
      title: plan.title,
      open: false,
    })
      .then(async (env) => {
        if (stopped) return;
        if (env.error || !env.data)
          throw Error(env.error?.message ?? "未能获取原文");
        setData(env.data);
        task = loadPdf(env.data.pdf);
        const pdf = await task.promise;
        if (!stopped) setDoc(pdf);
      })
      .catch((e: Error) => {
        if (!stopped) setError(e.message);
      });
    return () => {
      stopped = true;
      void task?.destroy();
      setDoc(null);
    };
    // 只在打开时取一次；plan 变化会重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan.id]);

  const labels = source.pageLabels
    ? `书页 ${source.pageLabels[0]}–${source.pageLabels[1]}`
    : null;
  const description = range
    ? `${plan.volume} · PDF 第 ${range.from}–${range.to} 页${labels ? `（${labels}）` : ""}`
    : plan.volume;

  return (
    <Modal
      title={`原文：${plan.title}`}
      description={description}
      open={open}
      onClose={onClose}
      wide
    >
      <div className="source-actions">
        {range && (
          <Button
            variant="primary"
            disabled={!data || opening}
            onClick={() => {
              setOpening(true);
              void call({
                kind: "curriculumPages",
                volume: source.volumeId,
                from: range.from,
                to: range.to,
                title: plan.title,
                open: true,
              }).finally(() => setOpening(false));
            }}
          >
            用系统预览打开
          </Button>
        )}
        <Button
          variant="quiet"
          onClick={() => void action({ kind: "openLink", url: source.url })}
        >
          下载整卷 PDF
        </Button>
        <Button
          variant="quiet"
          onClick={() =>
            void action({ kind: "openLink", url: planIndexMeta.source })
          }
        >
          教务部培养方案页
        </Button>
        {data && (
          <span className="subtle source-path">已保存到 {data.path}</span>
        )}
      </div>
      {!range ? (
        <p className="subtle">
          这份方案的数据没有记录页码，请下载整卷 PDF 后按目录查找。
        </p>
      ) : error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : !doc ? (
        <p className="subtle">
          正在获取原文。首次需要下载整卷 PDF（约 60
          MB）并抽取几页，之后离线秒开。
        </p>
      ) : (
        <div className="source-pages">
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i} doc={doc} page={i + 1} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function PdfPage({ doc, page }: { doc: PDFDocumentProxy; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let render: { cancel: () => void } | undefined;
    void doc
      .getPage(page)
      .then((p) => {
        if (cancelled || !canvas.current) return;
        const original = p.getViewport({ scale: 1 });
        const width = Math.min(760, original.width * 1.3);
        const viewport = p.getViewport({ scale: width / original.width });
        const ratio = Math.min(devicePixelRatio || 1, 2);
        const c = canvas.current;
        c.width = viewport.width * ratio;
        c.height = viewport.height * ratio;
        c.style.width = `${viewport.width}px`;
        c.style.height = `${viewport.height}px`;
        const task = p.render({
          canvas: c,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        render = task;
        return task.promise;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, page]);
  return <canvas ref={canvas} aria-label={`原文第 ${page} 页`} />;
}
