import { useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import {
  useResource,
  openOfficial,
  fmtTime,
  type Assignment,
  type Course,
} from "../lib/api";
import { Button, Empty, Resource, Search, type Login } from "../components/ui";
import { AssignmentDetails } from "../components/AssignmentDetails";
import { usePageParams } from "../lib/navigation";

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
  const submitted = !!a.last_attempt;
  const deadline = a.deadline ? Date.parse(a.deadline) : Infinity;
  if (filter === "submitted") return submitted;
  if (filter === "overdue") return !submitted && deadline < now;
  return !submitted && deadline >= now;
}
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
      const soonest = (x: Assignment) =>
        x.deadline ? Date.parse(x.deadline) : Infinity;
      const latest = (x: Assignment) =>
        x.deadline ? Date.parse(x.deadline) : 0;
      // 待交按截止时间由近到远；其余分类反过来，最近截止的排前面。
      const byDeadline =
        filter === "pending"
          ? soonest(a) - soonest(b)
          : latest(b) - latest(a) || soonest(a) - soonest(b);
      return byDeadline || a.title.localeCompare(b.title, "zh-CN");
    });
  if (activeId)
    return (
      <section className="assignment-full">
        <Button
          variant="quiet"
          className="back-link"
          onClick={() => select(undefined)}
        >
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
            const active = assignments.find((a) => a.hash_id === activeId);
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
      <Resource
        title="作业列表"
        q={q}
        service="course"
        login={login}
        className="resource-plain"
        heading={<span className="subtle">{rows.length} 项作业</span>}
      >
        {() =>
          rows.length ? (
            <div className="assignment-index">
              {rows.map((a) => {
                const state = assignmentStatus(a);
                return (
                  <button
                    key={a.hash_id}
                    className="assignment-choice"
                    onClick={() => select(a.hash_id)}
                  >
                    <strong>{a.title}</strong>
                    <small>
                      {a.course_name}
                      {a.score ? ` · 分数 ${a.score}` : ""}
                    </small>
                    <span
                      className={state === "overdue" ? "overdue" : "subtle"}
                    >
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
              })}
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
