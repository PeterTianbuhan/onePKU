import {
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  Inbox,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  RefreshCw,
  Search as SearchIcon,
  X,
} from "lucide-react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  action,
  call,
  fmtTime,
  openOfficial,
  type Attachment,
  type Request,
  type Envelope,
  type Service,
  type LoginTarget,
} from "../lib/api";
const AttachmentPreview = lazy(() => import("./AttachmentPreview"));
export type Login = (
  service: LoginTarget,
  scope?: "treehole" | "timetable",
) => void;
export function Button({
  children,
  variant = "",
  className = "",
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button
      type="button"
      className={`button ${variant} ${className}`}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}
export function Empty({
  children,
  icon = <Inbox />,
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <p>{children}</p>
    </div>
  );
}
export function ActionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details
      className="action-menu"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          e.currentTarget.open = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.open = false;
          e.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={label} title={label}>
        <MoreHorizontal size={18} />
      </summary>
      <div
        className="action-menu-items"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button:not(:disabled)")) {
            const details = e.currentTarget.parentElement as HTMLDetailsElement;
            details.open = false;
            details.querySelector("summary")?.focus();
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}
export function Resource<T>({
  title,
  heading,
  q,
  children,
  service,
  login,
  extra,
  officialTarget,
  className = "",
  hideRefresh = false,
}: {
  title: string;
  heading?: ReactNode;
  q: UseQueryResult<Envelope<T>, Error>;
  children: (data: T) => ReactNode;
  service?: Service;
  login: Login;
  extra?: ReactNode;
  officialTarget?: string;
  className?: string;
  hideRefresh?: boolean;
}) {
  const env = q.data;
  const issue =
    env?.error ??
    (q.error ? { code: "network", message: q.error.message } : null);
  return (
    <section
      className={`resource ${className}`}
      aria-label={title}
      aria-busy={q.isFetching}
    >
      <div className="resource-head">
        {heading ?? <h2>{title}</h2>}
        <div className="head-actions">
          {extra}
          {!hideRefresh && (
            <button
              className="icon-button"
              aria-label={`刷新${title}`}
              title={
                env?.updatedAt
                  ? `刷新${title} · 上次成功更新 ${fmtTime(env.updatedAt)}`
                  : `刷新${title}`
              }
              disabled={q.isFetching}
              onClick={() => void q.refetch()}
            >
              <RefreshCw size={16} className={q.isFetching ? "spin" : ""} />
            </button>
          )}
        </div>
      </div>
      {issue && (
        <div className="resource-error" role="status">
          <AlertCircle size={15} />
          <span>
            {env?.stale ? "更新失败，当前显示上次数据。" : issue.message}
          </span>
          {service && ["auth", "sms", "courseSms"].includes(issue.code) && (
            <button
              className="text-button"
              onClick={() =>
                login(
                  service,
                  issue.code === "courseSms"
                    ? "timetable"
                    : issue.code === "sms"
                      ? "treehole"
                      : undefined,
                )
              }
            >
              {issue.code === "courseSms" || issue.code === "sms"
                ? "短信验证"
                : "重新登录"}
            </button>
          )}
        </div>
      )}
      {!env?.data && q.isFetching ? (
        <div className="skeleton" aria-label="正在加载">
          <i />
          <i />
          <i />
        </div>
      ) : env?.data !== null && env?.data !== undefined ? (
        children(env.data)
      ) : !issue ? (
        <Empty>等待更新</Empty>
      ) : (
        <div className="error-actions">
          <Button onClick={() => void q.refetch()}>重试</Button>
          {service && (
            <Button
              onClick={() => void openOfficial(officialTarget ?? service)}
            >
              打开{service === "course" ? "教学网" : "官网"}
            </Button>
          )}
        </div>
      )}
      {!!env?.warnings.length && (
        <details className="partial">
          <summary>部分内容未更新 · {env.warnings.length} 项</summary>
          {env.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </details>
      )}
    </section>
  );
}
export function Modal({
  title,
  description,
  open,
  onClose,
  children,
  wide = false,
  dismissible = true,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const trigger = useRef(document.activeElement as HTMLElement | null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => !o && dismissible && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          onEscapeKeyDown={(e) => {
            if (document.fullscreenElement || !dismissible) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (!dismissible) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
          className={`modal ${wide ? "wide" : ""}`}
        >
          <div className="modal-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close
              className="icon-button"
              aria-label="关闭"
              disabled={!dismissible}
            >
              <X />
            </Dialog.Close>
          </div>
          <Dialog.Description
            className={description ? "modal-description" : "sr-only"}
          >
            {description ?? "查看详情，按 Escape 关闭"}
          </Dialog.Description>
          <div className="modal-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search">
      <SearchIcon size={17} />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          className="icon-button"
          aria-label="清空搜索"
          onClick={() => onChange("")}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
export function Pager({
  page,
  onChange,
  hasNext,
  busy = false,
}: {
  page: number;
  onChange: (n: number) => void;
  hasNext: boolean;
  busy?: boolean;
}) {
  return (
    <div className="pager">
      <Button
        aria-label="上一页"
        disabled={page === 1 || busy}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeft size={16} />
      </Button>
      <span>第 {page} 页</span>
      <Button
        aria-label="下一页"
        disabled={!hasNext || busy}
        onClick={() => onChange(page + 1)}
      >
        <ChevronRight size={16} />
      </Button>
    </div>
  );
}
export function AttachmentRow({
  file,
  course,
  onPreview,
  request,
  extra,
  icon,
}: {
  file: Attachment;
  course?: string;
  onPreview?: () => void;
  request?: Request;
  extra?: ReactNode;
  icon?: ReactNode;
}) {
  const client = useQueryClient();
  const [preview, setPreview] = useState(false);
  const [job, setJob] = useState<string>();
  const [state, setState] = useState<{
    state: string;
    bytes?: number;
    path?: string;
    message?: string;
    phase?: string;
    completed?: number;
    segments?: number;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!job) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const v = await action<NonNullable<typeof state>>({
          kind: "downloadStatus",
          id: job!,
        });
        if (live) {
          setState(v);
          if (["running", "queued"].includes(v.state))
            timer = setTimeout(poll, 700);
        }
      } catch {
        if (live) setError("无法读取下载进度");
      }
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [job]);
  async function download() {
    setBusy(true);
    setError("");
    try {
      const d = await action<{ id: string }>(
        request ?? {
          kind: "download",
          id: file.downloadId!,
        },
      );
      setJob(d.id);
      void client.invalidateQueries({ queryKey: ["downloads"] });
      setState({ state: "running", bytes: 0 });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="attachment">
      <div className="attachment-line">
        {icon ?? <FileText size={18} />}
        {course && file.downloadId ? (
          <button
            className="attachment-name text-button"
            onClick={() => (onPreview ? onPreview() : setPreview(true))}
            title="打开预览"
          >
            {file.name}
          </button>
        ) : (
          <span>{file.name}</span>
        )}
        {extra}
        {(file.downloadId || request) && (
          <Button
            disabled={
              busy || ["running", "queued"].includes(state?.state ?? "")
            }
            onClick={() => void download()}
          >
            <Download size={15} />
            {state?.state === "done"
              ? "再次下载"
              : request?.kind === "downloadVideo"
                ? "下载 MP4"
                : "下载"}
          </Button>
        )}
      </div>
      {["running", "queued"].includes(state?.state ?? "") && (
        <div className="download-status" role="status">
          {state?.state === "queued"
            ? "等待下载"
            : state?.phase === "preparing"
              ? "正在获取下载信息"
              : state?.phase === "converting"
                ? "正在合并为 MP4"
                : `已下载 ${((state?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB${state?.segments ? ` · ${state.completed}/${state.segments} 段` : ""}`}{" "}
          <button
            className="text-button"
            onClick={() => void call({ kind: "downloadCancel", id: job! })}
          >
            取消
          </button>
        </div>
      )}
      {state?.state === "done" && (
        <p className="download-status success">已保存至 {state.path}</p>
      )}
      {state?.state === "cancelled" && (
        <p className="download-status">下载已取消</p>
      )}
      {(error || state?.state === "failed") && (
        <p className="inline-error" role="alert">
          {error || state?.message}
        </p>
      )}
      {preview && course && file.downloadId && (
        <Modal title={file.name} open wide onClose={() => setPreview(false)}>
          <Suspense fallback={<p className="subtle">正在打开预览…</p>}>
            <AttachmentPreview course={course} downloadId={file.downloadId} />
          </Suspense>
        </Modal>
      )}
    </div>
  );
}
