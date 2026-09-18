import { useQuery, type QueryClient } from "@tanstack/react-query";
export type Service = "course" | "treehole" | "campuscard" | "bdkj";
export type Request = {
  kind: string;
  [key: string]:
    string | number | boolean | null | string[] | Record<string, unknown>;
};
export type Envelope<T> = {
  data: T | null;
  updatedAt: string | null;
  stale: boolean;
  error: { code: string; message: string } | null;
  warnings: string[];
  generation: string;
};
export async function call<T = unknown>(
  request: Request,
  signal?: AbortSignal,
): Promise<Envelope<T>> {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<Envelope<T>>("campus", { request });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  }
  const r = await fetch("/api", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-OnePKU": "1" },
    body: JSON.stringify(request),
  });
  if (!r.ok) throw Error("暂时无法连接本地服务");
  return r.json();
}
export function useResource<T>(request: Request, enabled = true) {
  return useQuery({
    queryKey: ["resource", request],
    queryFn: ({ signal }) => call<T>(request, signal),
    enabled,
    retry: false,
    staleTime:
      request.kind === "localMaterials"
        ? 0
        : request.kind === "calendarPdf"
          ? 24 * 60 * 60 * 1000
          : 5 * 60 * 1000,
    refetchInterval:
      request.kind === "localMaterials"
        ? 5000
        : ["news", "notices", "assignments"].includes(request.kind)
          ? 5 * 60 * 1000
          : false,
    refetchIntervalInBackground: true,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}
export async function action<T = unknown>(request: Request) {
  const result = await call<T>(request);
  if (result.error) throw Error(result.error.message);
  return result.data as T;
}
export async function openOfficial(target: string) {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("open_browser", { target });
  }
  return action({ kind: "open", target });
}
export const serviceNames: Record<Service, string> = {
  bdkj: "北大空间",
  course: "教学网",
  treehole: "树洞",
  campuscard: "校园卡",
};
export const fmtTime = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value).toLocaleString(
    "zh-CN",
    {
      timeZone: "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    },
  );
export const money = (cents: number) =>
  (cents / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export type Course = {
  id: string;
  name: string;
  semester?: string;
  current?: boolean;
};
export type Attachment = { name: string; downloadId?: string };
export type Assignment = {
  hash_id: string;
  course_name: string;
  course_id: string;
  content_id: string;
  title: string;
  deadline_raw: string | null;
  deadline: string | null;
  last_attempt: string | null;
  detail_error: boolean;
  descriptions: string[];
  attachments: Attachment[];
};
export type Notice = {
  course_id?: string;
  course_name: string;
  announcement: {
    id?: string;
    url?: string;
    title: string;
    body: string;
    date: string;
    author: string;
  };
};
export type Content = {
  id: string;
  title: string;
  item_type: string;
  description: string;
  attachments: Attachment[];
};
export type Hole = {
  pid: number;
  text: string;
  timestamp: number;
  reply: number;
  likenum: number;
  media_ids: string;
};

export function serviceFor(request: Request): Service | undefined {
  if (["bookingGrid", "bookingApplications"].includes(request.kind))
    return "bdkj";
  if (
    [
      "courses",
      "allCourses",
      "videos",
      "content",
      "localMaterials",
      "assignments",
      "courseAssignments",
      "courseNotices",
      "assignmentFeedback",
      "learningGrades",
      "recordings",
      "recordingSessions",
      "notices",
    ].includes(request.kind)
  )
    return "course";
  if (["timetable", "holes", "hole", "scores", "exams"].includes(request.kind))
    return "treehole";
  if (["card", "transactions", "cardStats"].includes(request.kind))
    return "campuscard";
}
export function resetService(client: QueryClient, service: Service) {
  void client.resetQueries({
    predicate: (q) =>
      q.queryKey[0] === "resource" &&
      serviceFor(q.queryKey[1] as Request) === service,
  });
  if (service === "course") {
    void client.resetQueries({ queryKey: ["downloads"] });
    void client.resetQueries({ queryKey: ["writeOperations"] });
  }
}

export function expiry(s: string) {
  return /^\d{8}$/.test(s)
    ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`
    : s;
}
export function schoolDate(s: string) {
  const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return m ? `${m[2]}月${m[3]}日` : s;
}

export function transactionAmount(cents: number, icon: string | null) {
  if (["recharge", "subsidy", "refund"].includes(icon ?? ""))
    return "+" + money(Math.abs(cents));
  if (icon === "consume") return "−" + money(Math.abs(cents));
  return money(cents);
}

export type StagedFile = {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
};
export type WriteOperation = {
  id: string;
  course: string;
  content: string;
  title: string;
  courseName: string;
  file: StagedFile;
  state:
    | "prepared"
    | "sending"
    | "confirmed"
    | "unknown"
    | "blocked"
    | "cancelled"
    | "closed";
  message: string;
  created: number;
  receipt: string | null;
};
export async function chooseAssignmentFile(): Promise<StagedFile | null> {
  if (!("__TAURI_INTERNALS__" in window))
    throw Error("请在 OnePKU 桌面应用中选择提交文件");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<StagedFile | null>("choose_assignment_file");
}
export type Preferences = {
  keepAlive: boolean;
  downloadRoot: string | null;
  downloadRootIsDefault: boolean;
};
/** 打开系统文件夹选择框并保存为下载与资料目录；取消返回 null。 */
export async function chooseDownloadFolder(): Promise<Preferences | null> {
  if (!("__TAURI_INTERNALS__" in window))
    throw Error("请在 OnePKU 桌面应用中更改保存位置");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Preferences | null>("choose_download_folder");
}
export type MaterialImport = {
  added: { name: string; bytes: number }[];
  reused: number;
  failed: { name: string; message: string }[];
};
export async function chooseCourseFiles(
  course: string,
): Promise<MaterialImport | null> {
  if (!("__TAURI_INTERNALS__" in window))
    throw Error("请在 OnePKU 桌面应用中添加资料");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MaterialImport | null>("choose_course_files", { course });
}
export const openAssignment = (course: string, content: string) =>
  action({ kind: "openAssignment", course, content });

export function assignmentNeedsFile(assignment: Assignment): boolean {
  return !assignment.descriptions.some((s) =>
    /无需提交(?:任何)?文件|不需要提交文件/.test(s),
  );
}

export async function chooseSubtitleFile<T>(id: string): Promise<T | null> {
  if (!("__TAURI_INTERNALS__" in window))
    throw Error("请在 OnePKU 桌面应用中导入字幕");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T | null>("choose_subtitle_file", { id });
}
