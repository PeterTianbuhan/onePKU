import { useEffect, useRef } from "react";
import { action } from "./api";

/** 一节课的播放进度。身份是原始 course_id + episode_id，不是本机缓存键。 */
export type ProgressRecord = {
  courseId: string;
  episodeId: string;
  positionSeconds: number;
  completed: boolean;
  updatedAt: string;
};

type SyncResponse = {
  enabled?: boolean;
  ok?: boolean;
  records?: ProgressRecord[];
};

const PUSH_DEBOUNCE_MS = 20_000;

export function progressInstant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** 位置按 updatedAt 后写为准；completed 一旦为真就保持。时间相同则采用 incoming。 */
export function mergeProgress(
  current: ProgressRecord | null,
  incoming: ProgressRecord | null,
): ProgressRecord | null {
  if (!current) return incoming;
  if (!incoming) return current;
  const winner =
    progressInstant(incoming.updatedAt) >= progressInstant(current.updatedAt)
      ? incoming
      : current;
  return { ...winner, completed: current.completed || incoming.completed };
}

export function syncStorageKey(courseId: string, episodeId: string) {
  return `onepku.playback.sync.${courseId}.${episodeId}`;
}

export function readSyncRecord(key: string): ProgressRecord | null {
  if (!key) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    if (
      !parsed ||
      typeof parsed.courseId !== "string" ||
      typeof parsed.episodeId !== "string" ||
      typeof parsed.positionSeconds !== "number" ||
      typeof parsed.completed !== "boolean" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as ProgressRecord;
  } catch {
    return null;
  }
}

export function writeSyncRecord(key: string, record: ProgressRecord) {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    /* 记不住进度不影响播放。 */
  }
}

export function initialResume(legacyKey: string, syncKey: string): number {
  const record = readSyncRecord(syncKey);
  if (
    record &&
    Number.isFinite(record.positionSeconds) &&
    record.positionSeconds >= 0
  ) {
    return record.positionSeconds;
  }
  try {
    const n = Number(localStorage.getItem(legacyKey));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 打开时拉取，进度变化后约 20 秒推一次。失败一律吞掉。
 * 返回的 note 在整段播放期间保持同一个函数。
 */
export function useProgressSync({
  courseId,
  episodeId,
  position,
  element,
  mediaReady,
  duration,
  legacyKey,
  onRemote,
}: {
  courseId?: string;
  episodeId: string;
  position: { current: number };
  element: { current: HTMLVideoElement | null };
  mediaReady: { current: boolean };
  duration: number | undefined;
  legacyKey: string;
  onRemote: (seconds: number) => void;
}) {
  const key = courseId ? syncStorageKey(courseId, episodeId) : "";
  const settled = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  function stored(): ProgressRecord | null {
    return readSyncRecord(key);
  }

  function send(record: ProgressRecord) {
    if (!courseId) return;
    void action<SyncResponse>({
      kind: "progressPush",
      courseId: record.courseId,
      episodeId: record.episodeId,
      positionSeconds: record.positionSeconds,
      completed: record.completed,
      updatedAt: record.updatedAt,
    })
      .then((data) => {
        if (!data?.ok || !Array.isArray(data.records)) return;
        const remote =
          data.records.find(
            (item) =>
              item.courseId === courseId && item.episodeId === episodeId,
          ) ?? null;
        const merged = mergeProgress(readSyncRecord(key), remote);
        if (merged) writeSyncRecord(key, merged);
      })
      .catch(() => {
        /* 推不出去就下次再试。 */
      });
  }

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (!settled.current || !dirty.current) return;
    const record = stored();
    dirty.current = false;
    if (record) send(record);
  }

  function note(
    seconds: number,
    opts?: { completed?: boolean; flush?: boolean },
  ) {
    if (!courseId || !key || !Number.isFinite(seconds) || seconds < 0) return;
    const length = durationRef.current ?? element.current?.duration ?? 0;
    const previous = stored();
    const completed =
      Boolean(opts?.completed) ||
      Boolean(previous?.completed) ||
      (Number.isFinite(length) && length > 10 && seconds >= length - 10);
    const incoming: ProgressRecord = {
      courseId,
      episodeId,
      positionSeconds: seconds,
      completed,
      updatedAt: new Date().toISOString(),
    };
    const merged = mergeProgress(previous, incoming);
    if (!merged) return;
    writeSyncRecord(key, merged);
    dirty.current = true;
    if (opts?.flush) flush();
    else if (settled.current) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, PUSH_DEBOUNCE_MS);
    }
  }

  const noteRef = useRef(note);
  noteRef.current = note;
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    settled.current = false;
    dirty.current = false;
    if (!courseId || !key) return;
    let live = true;
    void action<SyncResponse>({ kind: "progressPull" })
      .then((data) => {
        if (!live || !data?.enabled || !data.ok || !Array.isArray(data.records))
          return;
        const remote =
          data.records.find(
            (item) =>
              item.courseId === courseId && item.episodeId === episodeId,
          ) ?? null;
        const local = readSyncRecord(key);
        const merged = mergeProgress(local, remote);
        if (!merged) return;
        writeSyncRecord(key, merged);
        if (Math.abs(merged.positionSeconds - position.current) > 0.5) {
          onRemoteRef.current(merged.positionSeconds);
        }
      })
      .catch(() => {
        /* 拉不到就用本机位置。 */
      })
      .finally(() => {
        if (!live) return;
        settled.current = true;
        flushRef.current();
      });
    return () => {
      live = false;
      settled.current = true;
      // 清掉的是这一次 effect 对应的课，不跟随后面渲染里换掉的 flush。
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      if (!dirty.current) return;
      const record = readSyncRecord(key);
      dirty.current = false;
      if (
        record &&
        record.courseId === courseId &&
        record.episodeId === episodeId
      ) {
        send(record);
      }
    };
    // legacyKey 跟着这节课走；position / element 是稳定的 ref。
  }, [courseId, episodeId, key, legacyKey, position, element]);

  return noteRef;
}
