import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileCheck2, LoaderCircle, RotateCcw, X } from "lucide-react";
import { action } from "../lib/api";
import { Modal, Button } from "./ui";
type Job = {
  id: string;
  name: string;
  state: string;
  bytes?: number;
  total?: number;
  path?: string;
  message?: string;
  phase?: string;
  completed?: number;
  segments?: number;
};
export default function Downloads() {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const q = useQuery({
    queryKey: ["downloads"],
    queryFn: () => action<Job[]>({ kind: "downloads" }),
    refetchInterval: (q) =>
      q.state.data?.some((j) => ["running", "queued"].includes(j.state))
        ? 700
        : false,
    retry: false,
  });
  const jobs = q.data ?? [];
  if (!jobs.length) return null;
  const running = jobs.filter((j) =>
    ["running", "queued"].includes(j.state),
  ).length;
  return (
    <>
      <button
        className="nav-settings"
        title="下载记录"
        onClick={() => setOpen(true)}
      >
        <Download size={19} />
        <span>下载{running ? ` · ${running}` : ""}</span>
      </button>
      <Modal
        title="下载记录"
        description="文件保存在「下载 / OnePKU」并按学期、课程归档；同名同内容复用，更新版本另存。"
        open={open}
        onClose={() => setOpen(false)}
      >
        {error && <p role="alert">{error}</p>}
        {jobs.map((j) => (
          <div className="download-record" key={j.id}>
            {["running", "queued"].includes(j.state) ? (
              <LoaderCircle size={18} className="spin" />
            ) : j.state === "done" ? (
              <FileCheck2 size={18} className="success" />
            ) : (
              <Download size={18} />
            )}
            <div className="grow">
              <strong>{j.name}</strong>
              <small>
                {j.state === "queued"
                  ? "等待下载"
                  : j.phase === "converting"
                    ? "正在合并为 MP4"
                    : j.phase === "preparing"
                      ? "正在获取下载信息"
                      : j.state === "done"
                        ? `已保存：${j.path}`
                        : ["running", "queued"].includes(j.state)
                          ? `已下载 ${((j.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB${j.total ? ` / ${(j.total / 1024 / 1024).toFixed(1)} MB` : ""}`
                          : j.state === "cancelled"
                            ? "已取消"
                            : (j.message ?? "下载失败")}
              </small>
              {j.state === "failed" && !!j.completed && (
                <small>
                  已完成 {j.completed} / {j.segments}{" "}
                  个分片，重试时复用完整分片。
                </small>
              )}
            </div>
            {["running", "queued"].includes(j.state) && (
              <Button
                aria-label={`取消下载 ${j.name}`}
                onClick={() =>
                  void action({ kind: "downloadCancel", id: j.id }).then(() =>
                    q.refetch(),
                  )
                }
              >
                <X size={14} />
              </Button>
            )}
            {["failed", "cancelled"].includes(j.state) && (
              <Button
                aria-label={`重试下载 ${j.name}`}
                disabled={retrying !== null}
                onClick={async () => {
                  setRetrying(j.id);
                  setError("");
                  try {
                    await action({ kind: "downloadRetry", id: j.id });
                    await q.refetch();
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : "重试失败，请从课程重新下载",
                    );
                  } finally {
                    setRetrying(null);
                  }
                }}
              >
                <RotateCcw size={14} />
                重试
              </Button>
            )}
          </div>
        ))}
      </Modal>
    </>
  );
}
