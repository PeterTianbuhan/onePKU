import { useQuery } from "@tanstack/react-query";
import { action, fmtTime, type WriteOperation } from "../lib/api";
import { OperationStatus } from "./Submission";
export default function WriteOperations() {
  const q = useQuery({
    queryKey: ["writeOperations"],
    queryFn: () => action<WriteOperation[]>({ kind: "writeOperations" }),
    refetchInterval: (q) =>
      q.state.data?.some((o) => o.state === "sending") ? 1000 : 10000,
    retry: false,
  });
  return (
    <details
      className="operation-summary"
      open={q.data?.some((o) => ["sending", "unknown"].includes(o.state))}
    >
      <summary>
        操作记录{" "}
        <span>
          {q.data?.some((o) => ["sending", "unknown"].includes(o.state))
            ? "有结果待核对"
            : q.data?.length
              ? `${q.data.length} 条`
              : q.isPending
                ? "读取中"
                : q.error
                  ? "读取失败"
                  : "暂无记录"}
        </span>
      </summary>
      <p className="footnote">提交结果保存在本机，重启后可继续核对。</p>
      {q.error ? (
        <p className="inline-error">暂时无法读取操作记录</p>
      ) : !q.data?.length ? (
        <p className="compact-empty">
          {q.isPending ? "正在读取操作记录…" : "还没有操作记录"}
        </p>
      ) : (
        q.data.slice(0, 30).map((o) => (
          <article className="operation-record" key={o.id}>
            <header>
              <div>
                <strong>{o.title}</strong>
                <small>
                  {o.courseName} · {o.file.name}
                </small>
              </div>
              <time className="subtle">{fmtTime(o.created)}</time>
            </header>
            <OperationStatus operation={o} onUpdate={() => void q.refetch()} />
          </article>
        ))
      )}
    </details>
  );
}
