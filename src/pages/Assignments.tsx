import { useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import {
  useResource,
  openOfficial,
  fmtTime,
  type Assignment,
  type Course,
  type Envelope,
} from "../lib/api";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button, Empty, Resource, Search, type Login } from "../components/ui";
import { AssignmentDetails } from "../components/AssignmentDetails";
import { usePageParams } from "../lib/navigation";
import { isPending } from "../lib/courseStatus";
import DueStamp from "../components/DueStamp";
import DeadlineRuler from "../components/DeadlineRuler";

export function assignmentStatus(a: Assignment, now = Date.now()) {
  if (a.detail_error) return "unknown";
  if (a.last_attempt) return "submitted";
  if (a.deadline && Date.parse(a.deadline) < now) return "overdue";
  return "pending";
}
// 分类与安卓端同一套判据：没有截止时间就不算已截止，一律按待交处理；
// 「状态待核对」（详情读不到）的作业也按同样的判据归类，只在行上标出来。
const filters = [
  { id: "pending", name: "待交" },
  { id: "submitted", name: "已提交" },
  { id: "overdue", name: "已截止" },
  { id: "all", name: "全部" },
];
function inFilter(a: Assignment, filter: string, now = Date.now()) {
  if (filter === "all") return true;
  if (filter === "submitted") return !!a.last_attempt;
  if (filter === "overdue") return !a.last_attempt && !isPending(a, now);
  return isPending(a, now);
}
const soonest = (a: Assignment) =>
  a.deadline ? Date.parse(a.deadline) : Infinity;
const latest = (a: Assignment) => (a.deadline ? Date.parse(a.deadline) : 0);

/** 清单里的一行：日期印、标题、课名或分数、状态。 */
function AssignmentRow({
  assignment: a,
  withCourse,
  onOpen,
}: {
  assignment: Assignment;
  withCourse?: boolean;
  onOpen: () => void;
}) {
  const state = assignmentStatus(a);
  const note = [withCourse && a.course_name, a.score && `分数 ${a.score}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <button className="assignment-choice" onClick={onOpen}>
      <DueStamp deadline={a.deadline} now={Date.now()} />
      <span className="grow">
        <strong>{a.title}</strong>
        {note && <small>{note}</small>}
      </span>
      <span className={`deadline ${state}`}>
        {state === "unknown"
          ? "状态待核对"
          : state === "submitted"
            ? "有提交记录"
            : a.deadline
              ? `${state === "overdue" ? "已截止 · " : "截止 "}${fmtTime(a.deadline)}`
              : null}
      </span>
    </button>
  );
}

/** 一项作业的整页详情，带一个回到清单的链接。 */
function AssignmentPage({
  q,
  id,
  back,
  login,
}: {
  q: UseQueryResult<Envelope<Assignment[]>>;
  id: string;
  back: () => void;
  login: Login;
}) {
  return (
    <section className="assignment-full">
      <Button variant="quiet" className="back-link" onClick={back}>
        <ArrowLeft size={17} />
        作业列表
      </Button>
      <Resource
        title="作业详情"
        q={q}
        service="course"
        login={login}
        className="resource-page"
      >
        {(assignments) => {
          const active = assignments.find((a) => a.hash_id === id);
          return active ? (
            <AssignmentDetails
              key={active.hash_id}
              assignment={active}
              login={login}
            />
          ) : (
            <Empty>当前列表未找到这项作业，请返回列表刷新。</Empty>
          );
        }}
      </Resource>
    </section>
  );
}

/**
 * 一门课里的作业：不分选项卡、不带搜索，一张清单看完。
 * 待交的在上面按截止时间排，交过的和过期的在下面。
 */
export function CourseAssignments({
  course,
  login,
}: {
  course: string;
  login: Login;
}) {
  const q = useResource<Assignment[]>({ kind: "courseAssignments", course });
  const [params, navigate] = usePageParams("课程");
  const selected = params.get("assignment");
  if (selected)
    return (
      <AssignmentPage
        q={q}
        id={selected}
        back={() => navigate({ assignment: null })}
        login={login}
      />
    );
  const open = (a: Assignment) => navigate({ assignment: a.hash_id });
  return (
    <Resource
      title="作业"
      q={q}
      service="course"
      login={login}
      heading={
        <span className="subtle">
          {q.data?.data
            ? `${q.data.data.filter((a) => isPending(a)).length} 项待交 · 共 ${q.data.data.length} 项`
            : ""}
        </span>
      }
    >
      {(data) => {
        const pending = data
          .filter((a) => isPending(a))
          .sort((a, b) => soonest(a) - soonest(b));
        const done = data
          .filter((a) => !isPending(a))
          .sort((a, b) => latest(b) - latest(a));
        if (!data.length) return <Empty>这门课还没有布置作业</Empty>;
        return (
          <>
            {pending.length ? (
              <div className="assignment-index">
                {pending.map((a) => (
                  <AssignmentRow
                    key={a.hash_id}
                    assignment={a}
                    onOpen={() => open(a)}
                  />
                ))}
              </div>
            ) : (
              <p className="compact-empty">没有待交的作业</p>
            )}
            {done.length > 0 && (
              <>
                <h3 className="list-divider">已交与已截止</h3>
                <div className="assignment-index">
                  {done.map((a) => (
                    <AssignmentRow
                      key={a.hash_id}
                      assignment={a}
                      onOpen={() => open(a)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        );
      }}
    </Resource>
  );
}

/** 跨课程的作业清单：搜索、按课程筛、按状态分。待交那一栏上面有两周的时间尺。 */
export function AssignmentWorkspace({
  login,
  course,
  selected,
  onSelect,
  courseFilter,
}: {
  login: Login;
  course?: string;
  selected?: string;
  onSelect?: (id?: string) => void;
  courseFilter?: ReactNode;
}) {
  const q = useResource<Assignment[]>(
    course ? { kind: "courseAssignments", course } : { kind: "assignments" },
  );
  const [search, setSearch] = useState("");
  // 与安卓端一样默认停在「待交」。
  const [filter, setFilter] = useState("pending");
  const [localSelected, setLocalSelected] = useState<string>();
  const activeId = onSelect ? selected : localSelected;
  const select = onSelect ?? setLocalSelected;
  const data = q.data?.data ?? [];
  const rows = data
    .filter(
      (a) =>
        `${a.title} ${a.course_name}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()) && inFilter(a, filter),
    )
    .sort((a, b) => {
      // 待交按截止时间由近到远；其余分类反过来，最近截止的排前面。
      const byDeadline =
        filter === "pending"
          ? soonest(a) - soonest(b)
          : latest(b) - latest(a) || soonest(a) - soonest(b);
      return byDeadline || a.title.localeCompare(b.title, "zh-CN");
    });
  if (activeId)
    return (
      <AssignmentPage
        q={q}
        id={activeId}
        back={() => select(undefined)}
        login={login}
      />
    );
  return (
    <>
      <div className="assignment-filters">
        <Search
          value={search}
          onChange={setSearch}
          placeholder="搜索作业或课程"
        />
        {courseFilter}
      </div>
      <div
        className="tabs assignment-tabs"
        role="tablist"
        aria-label="作业分类"
      >
        {filters.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? "active" : ""}
            onClick={() => setFilter(f.id)}
          >
            {f.name}
          </button>
        ))}
      </div>
      {filter === "pending" && !search.trim() && data.length > 0 && (
        <DeadlineRuler
          assignments={data}
          now={Date.now()}
          onOpen={(a) => select(a.hash_id)}
        />
      )}
      <Resource
        title="作业列表"
        q={q}
        service="course"
        login={login}
        heading={<span className="subtle">{rows.length} 项作业</span>}
      >
        {() =>
          rows.length ? (
            <div className="assignment-index">
              {rows.map((a) => (
                <AssignmentRow
                  key={a.hash_id}
                  assignment={a}
                  withCourse
                  onOpen={() => select(a.hash_id)}
                />
              ))}
            </div>
          ) : (
            <Empty>
              {data.length ? "没有符合筛选条件的作业" : "本次查询未列出作业"}
            </Empty>
          )
        }
      </Resource>
    </>
  );
}
export default function Assignments({ login }: { login: Login }) {
  const courses = useResource<Course[]>({ kind: "allCourses" });
  const [params, navigate] = usePageParams("作业");
  const course = params.get("course") ?? "";
  const selected = params.get("assignment") ?? undefined;
  return (
    <>
      {!selected && (
        <>
          <header className="page-heading">
            <h1>作业</h1>
            <Button onClick={() => void openOfficial("course")}>
              打开教学网
            </Button>
          </header>
        </>
      )}
      <AssignmentWorkspace
        key={course}
        courseFilter={
          <select
            aria-label="作业课程"
            value={course}
            onChange={(e) =>
              navigate({ course: e.target.value, assignment: null })
            }
          >
            <option value="">本学期全部课程</option>
            {(courses.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.semester}
              </option>
            ))}
          </select>
        }
        course={course || undefined}
        login={login}
        selected={selected}
        onSelect={(id) => navigate({ assignment: id ?? null })}
      />
    </>
  );
}
