import { lazy, Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { action, call, type Request } from "../lib/api";
import type { Material } from "./LocalMaterials";
import { Button } from "./ui";

const MaterialPreview = lazy(() => import("./MaterialPreview"));

/** Resolve by source identity, never by filename: different files can share a name. */
export default function AttachmentPreview({
  course,
  downloadId,
}: {
  course: string;
  downloadId: string;
}) {
  const client = useQueryClient();
  const [local, setLocal] = useState<{ file: Material; generation: string }>();
  const [status, setStatus] = useState("正在打开附件…");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let generation: string | undefined;
    setLocal(undefined);
    setError("");
    setStatus("正在打开附件…");
    async function read<T>(request: Request): Promise<T> {
      const env = await call<T>(request);
      if (stopped) throw Error("预览已关闭");
      if (generation !== undefined && env.generation !== generation)
        throw Error("账号已变化，请关闭预览并刷新作业");
      generation = env.generation;
      if (env.error || env.data === null)
        throw Error(env.error?.message ?? "无法打开附件");
      return env.data;
    }
    async function findLocal() {
      const files = await read<Material[]>({ kind: "localMaterials", course });
      return files
        .filter(
          (f) =>
            f.downloadId === downloadId || f.downloadIds?.includes(downloadId),
        )
        .sort((a, b) => b.modified - a.modified)[0];
    }
    async function open() {
      let file = await findLocal();
      if (!file) {
        setStatus("正在下载附件，完成后自动预览…");
        const job = await read<{ id: string }>({
          kind: "download",
          id: downloadId,
        });
        void client.invalidateQueries({ queryKey: ["downloads"] });
        while (!stopped) {
          const progress = await read<{ state: string; message?: string }>({
            kind: "downloadStatus",
            id: job.id,
          });
          if (progress.state === "done") break;
          if (!["running", "queued"].includes(progress.state))
            throw Error(
              progress.message ??
                (progress.state === "cancelled"
                  ? "下载已取消"
                  : "附件下载失败"),
            );
          await new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 700);
          });
        }
        if (stopped) return;
        file = await findLocal();
        void client.invalidateQueries({
          queryKey: ["resource", { kind: "localMaterials", course }],
        });
      }
      if (!file) throw Error("下载完成，但未找到附件，请刷新作业后重试");
      setLocal({ file, generation: generation! });
    }
    void open().catch((e) => {
      if (!stopped) setError(e.message);
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [course, downloadId, attempt, client]);

  const canPreview =
    local &&
    local.file.bytes <= 32 * 1024 * 1024 &&
    /\.(pdf|png|jpe?g|webp|txt|md|csv|srt|vtt)$/i.test(local.file.name);
  return (
    <div className="attachment-preview">
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!local ? (
        error ? (
          <Button onClick={() => setAttempt((n) => n + 1)}>重试预览</Button>
        ) : (
          <p role="status" className="subtle">
            {status}
          </p>
        )
      ) : (
        <>
          <Button
            onClick={() =>
              void action({
                kind: "openLocalMaterial",
                course,
                id: local.file.id,
              }).catch((e) => setError(e.message))
            }
          >
            用默认应用打开
          </Button>
          {canPreview ? (
            <Suspense fallback={<p className="subtle">正在打开预览…</p>}>
              <MaterialPreview
                course={course}
                id={local.file.id}
                generation={local.generation}
              />
            </Suspense>
          ) : (
            <p className="subtle">
              此文件格式或大小暂不支持应用内预览，请用默认应用打开。
            </p>
          )}
        </>
      )}
    </div>
  );
}
