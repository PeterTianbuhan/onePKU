import { trashName } from "../lib/platform";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, Plus, RefreshCw } from "lucide-react";
import {
  action,
  chooseCourseFiles,
  useResource,
  type Content,
  type Attachment,
} from "../lib/api";
import { ActionMenu, AttachmentRow, Button, Resource, type Login } from "./ui";

export type Material = {
  id: string;
  name: string;
  bytes: number;
  modified: number;
  source: string;
  downloadId?: string | null;
};
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export default function LocalMaterials({
  course,
  search,
  login,
}: {
  course: string;
  search: string;
  login: Login;
}) {
  const q = useResource<Material[]>({ kind: "localMaterials", course });
  const content = useResource<Content[]>({ kind: "content", course });
  const client = useQueryClient();
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState<string>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const files = q.data?.data ?? [];
  const entries = content.data?.data ?? [];
  const ids = new Set(
    entries.flatMap((c) =>
      c.attachments.flatMap((f) => (f.downloadId ? [f.downloadId] : [])),
    ),
  );
  const remaining = files.filter(
    (f) => !f.downloadId || !ids.has(f.downloadId),
  );
  const matches = (name: string) =>
    name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const copies = new Map<string, Material[]>();
  for (const file of files) {
    if (file.downloadId)
      copies.set(file.downloadId, [
        ...(copies.get(file.downloadId) ?? []),
        file,
      ]);
  }
  const localFor = (attachment: Attachment) =>
    attachment.downloadId ? (copies.get(attachment.downloadId) ?? []) : [];
  const pendingIds = [...ids].filter((id) => !copies.has(id));
  async function add() {
    setBusy("import");
    setError("");
    setMessage("");
    try {
      const result = await chooseCourseFiles(course);
      if (result) {
        const added = result.added.length - result.reused;
        setMessage(
          [
            added ? `已添加 ${added} 份资料` : "",
            result.reused ? `${result.reused} 份资料已存在` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
        setError(
          result.failed.map((f) => `${f.name}：${f.message}`).join("；"),
        );
        await q.refetch();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "未能添加资料");
    } finally {
      setBusy(undefined);
    }
  }
  async function operate(
    kind: "openLocalMaterial" | "trashLocalMaterial",
    file: Material,
  ) {
    setBusy(file.id);
    setError("");
    setMessage("");
    try {
      await action({ kind, course, id: file.id });
      if (kind === "trashLocalMaterial") {
        setConfirm(undefined);
        setMessage(`已将「${file.name}」移到${trashName()}`);
        await q.refetch();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成，请重试");
    } finally {
      setBusy(undefined);
    }
  }
  async function download(ids: string[]) {
    setBusy("download");
    setError("");
    setMessage("");
    try {
      const r = await action<{ accepted: unknown[]; failed: string[] }>({
        kind: "downloadBatch",
        ids,
      });
      setMessage(
        `已加入 ${r.accepted.length} 个下载${r.failed.length ? `，${r.failed.length} 个未能加入，请重试` : ""}`,
      );
      void client.invalidateQueries({ queryKey: ["downloads"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法开始下载");
    } finally {
      setBusy(undefined);
    }
  }
  function fileRow(file: Material, downloaded = false) {
    return (
      <div className="local-material-row" key={file.id}>
        <button
          className="local-material-name"
          onClick={() => void operate("openLocalMaterial", file)}
          disabled={!!busy}
        >
          <FileText size={18} />
          <span>
            {file.name}{" "}
            <small>
              {downloaded ? "已下载 · 本地副本" : file.source} ·{" "}
              {size(file.bytes)}
            </small>
          </span>
        </button>
        {confirm === file.id ? (
          <div className="local-material-confirm">
            <span>移到{trashName()}？</span>
            <Button
              autoFocus
              variant="quiet"
              disabled={!!busy}
              onClick={() => setConfirm(undefined)}
            >
              取消
            </Button>
            <Button
              disabled={!!busy}
              onClick={() => void operate("trashLocalMaterial", file)}
            >
              移到{trashName()}
            </Button>
          </div>
        ) : (
          <ActionMenu label={`${file.name} 的更多操作`}>
            {downloaded && file.downloadId && (
              <Button
                variant="quiet"
                disabled={!!busy}
                onClick={() => void download([file.downloadId!])}
              >
                重新下载
              </Button>
            )}
            <Button
              variant="quiet"
              disabled={!!busy}
              onClick={() => setConfirm(file.id)}
              aria-label={`删除 ${file.name}`}
            >
              移到{trashName()}
            </Button>
          </ActionMenu>
        )}
      </div>
    );
  }
  return (
    <section className="materials-workspace" aria-label="课程资料">
      <div className="materials-toolbar">
        <span className="subtle">
          {files.length ? `${files.length} 份已在本机` : ""}
        </span>
        <div className="head-actions">
          <Button
            variant="quiet"
            onClick={() =>
              void action({ kind: "openArchive", course }).catch((e) =>
                setError(e.message),
              )
            }
            aria-label="打开课程资料文件夹"
            title="打开文件夹"
          >
            <FolderOpen size={17} />
          </Button>
          <Button disabled={!!busy} onClick={() => void add()}>
            <Plus size={16} />
            {busy === "import" ? "正在添加…" : "添加资料"}
          </Button>
          {!!pendingIds.length && (
            <Button
              variant="quiet"
              disabled={!!busy}
              onClick={() => void download(pendingIds)}
            >
              下载未保存资料（{pendingIds.length}）
            </Button>
          )}
          <Button
            variant="quiet"
            aria-label="刷新课程资料"
            title="刷新课程资料"
            disabled={q.isFetching || content.isFetching}
            onClick={() => {
              void q.refetch();
              void content.refetch();
            }}
          >
            <RefreshCw
              size={16}
              className={q.isFetching || content.isFetching ? "spin" : ""}
            />
          </Button>
        </div>
      </div>
      {message && (
        <p className="subtle" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <Resource
        title="教学网资料"
        heading={<h3>教学网</h3>}
        className="resource-plain material-source"
        hideRefresh
        q={content}
        login={login}
        service="course"
      >
        {(data) => {
          const rows = data.filter(
            (c) =>
              matches(c.title) ||
              c.attachments.some(
                (a) =>
                  matches(a.name) || localFor(a).some((f) => matches(f.name)),
              ),
          );
          return rows.length ? (
            <div className="content-list">
              {rows.map((c, i) => {
                const only =
                  c.attachments.length === 1 ? c.attachments[0] : undefined;
                if (
                  only &&
                  !c.description &&
                  c.item_type !== "Folder" &&
                  (c.title === only.name ||
                    c.title === only.name.replace(/\.[^.]+$/, ""))
                ) {
                  return (
                    <div className="material-entry" key={`${c.id}-${i}`}>
                      {localFor(only).length ? (
                        localFor(only).map((local) => fileRow(local, true))
                      ) : (
                        <AttachmentRow file={only} />
                      )}
                    </div>
                  );
                }
                return (
                  <details
                    key={`${c.id}-${i}`}
                    className="content-item"
                    open={!!search.trim() || rows.length < 5}
                  >
                    <summary>
                      <FileText size={16} />
                      <span>{c.title}</span>
                      <small>
                        {c.item_type === "Folder"
                          ? "文件夹"
                          : c.item_type === "Assignment"
                            ? "作业"
                            : "资料"}
                      </small>
                    </summary>
                    {c.description && <p className="prose">{c.description}</p>}
                    {c.attachments
                      .filter((f) => f.name.trim())
                      .map((f, i) =>
                        localFor(f).length ? (
                          <div key={i}>
                            {localFor(f).map((local) => fileRow(local, true))}
                          </div>
                        ) : (
                          <AttachmentRow key={i} file={f} />
                        ),
                      )}
                    {!c.attachments.length && !c.description && (
                      <p className="subtle">此条目没有正文或附件。</p>
                    )}
                  </details>
                );
              })}
            </div>
          ) : (
            <p className="compact-empty">
              {search ? "没有匹配的教学网资料" : "教学网暂未列出资料"}
            </p>
          );
        }}
      </Resource>
      {(remaining.length > 0 || !files.length || q.error || q.data?.error) && (
        <Resource
          title="本机资料"
          heading={<h3>本机补充</h3>}
          className="resource-plain material-source"
          hideRefresh
          q={q}
          login={login}
          service="course"
        >
          {() =>
            remaining.some((f) => matches(f.name)) ? (
              <div className="local-material-list">
                {remaining
                  .filter((f) => matches(f.name))
                  .map((f) => fileRow(f))}
              </div>
            ) : (
              <p className="compact-empty">
                {search ? "没有匹配的本机资料" : "还没有本机资料"}
              </p>
            )
          }
        </Resource>
      )}
    </section>
  );
}
