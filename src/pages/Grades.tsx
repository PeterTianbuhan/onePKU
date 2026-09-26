import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { useResource, openOfficial, action } from "../lib/api";
import { Button, Empty, Modal, Resource, type Login } from "../components/ui";
import {
  calculateGrades,
  officialGpa,
  gradeRulesUrl,
  type Scores,
  type GradeScope,
  type GradeOverrides,
  emptyGradeOverrides,
  countsAsMajor,
  gradeCourseKey,
  setGradeIncluded,
} from "../lib/grades";

function GradeSummary({
  data,
  semester,
  scope,
  overrides,
}: {
  data: Scores;
  semester: string;
  scope: GradeScope;
  overrides: GradeOverrides;
}) {
  const [openError, setOpenError] = useState("");
  const courses = data.courses.filter(
    (c) =>
      (semester === "all" || `${c.xnd}-${c.xq}` === semester) &&
      (scope === "all" || countsAsMajor(c, overrides)),
  );
  const calculated = calculateGrades(courses);
  const official =
    scope === "major"
      ? null
      : officialGpa(
          semester === "all"
            ? data.overall_gpa
            : data.semester_gpas.find((s) => s.xndxq === semester)?.gpa,
        );
  const gpa = official ?? calculated.gpa;
  return (
    <>
      <div className="study-metrics grade-metrics">
        <div>
          <div className="grade-label">
            <span>
              {scope === "major"
                ? "专业课 GPA"
                : semester === "all"
                  ? "累计 GPA"
                  : "学期 GPA"}
            </span>
            <details
              className="grade-help"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget))
                  e.currentTarget.open = false;
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.currentTarget.open = false;
                  e.currentTarget.querySelector("summary")?.focus();
                }
              }}
            >
              <summary aria-label="成绩计算说明">
                <CircleHelp size={14} aria-hidden="true" />
              </summary>
              <div className="grade-help-content">
                <p>
                  GPA 按北大本科规则、平均分按学分加权。当前纳入{" "}
                  {calculated.included} 条成绩，共 {calculated.credits} 学分。
                </p>
                <p>
                  W、IP、合格制等不计入，重修逐次计入。毕业论文、综合性考试依名称和类别排除；以学校成绩单为准。
                </p>
                <Button
                  variant="quiet"
                  onClick={() => {
                    void action({ kind: "openLink", url: gradeRulesUrl }).catch(
                      () => setOpenError("官方规则暂时未能打开"),
                    );
                  }}
                >
                  查看官方规则与公式
                </Button>
                {openError && <p role="alert">{openError}</p>}
              </div>
            </details>
          </div>
          <strong>{gpa?.toFixed(2) ?? "—"}</strong>
          <span>
            {official !== null
              ? "学校返回"
              : scope === "major"
                ? "按所选范围本地计算"
                : "按官方规则计算"}
          </span>
        </div>
        <div>
          <span>学分加权平均分</span>
          <strong>{calculated.average?.toFixed(2) ?? "—"}</strong>
          <span>本地计算</span>
        </div>
        <div>
          <span>{scope === "major" ? "计入统计学分" : "累计已获学分"}</span>
          <strong>
            {scope === "major" ? calculated.credits : data.total_credits || "—"}
          </strong>
          <span>{scope === "major" ? "有有效数字成绩的课程" : "学校返回"}</span>
        </div>
      </div>
    </>
  );
}

export default function Grades({ login }: { login: Login }) {
  const scores = useResource<Scores>({ kind: "scores" });
  const [semester, setSemester] = useState("all");
  const terms = [
    ...new Set(
      (scores.data?.data?.courses ?? []).map((c) => `${c.xnd}-${c.xq}`),
    ),
  ]
    .sort()
    .reverse();
  return (
    <>
      <header className="page-heading">
        <h1>成绩</h1>
        <Button onClick={() => void openOfficial("portal")}>
          打开校内门户
        </Button>
      </header>
      <Resource
        title="课程成绩"
        heading={
          <select
            aria-label="成绩学期"
            value={semester}
            onChange={(e) => setSemester(e.target.value)}
          >
            <option value="all">全部学期</option>
            {terms.map((t) => (
              <option key={t} value={t}>
                {t.replace(/-(\d)$/, " 学年第$1学期")}
              </option>
            ))}
          </select>
        }
        q={scores}
        login={login}
        service="treehole"
      >
        {(data) => (
          <GradeContent
            key={scores.data?.generation}
            data={data}
            generation={scores.data?.generation ?? ""}
            semester={semester}
          />
        )}
      </Resource>
    </>
  );
}

function GradeContent({
  data,
  generation,
  semester,
}: {
  data: Scores;
  generation: string;
  semester: string;
}) {
  const [scope, setScope] = useState<GradeScope>("all");
  const scopeQuery = useResource<GradeOverrides>(
    { kind: "gradeScope", generation },
    scope === "major",
  );
  const [draft, setDraft] = useState<GradeOverrides | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const overrides =
    scopeQuery.data?.generation === generation
      ? (scopeQuery.data.data ?? emptyGradeOverrides)
      : emptyGradeOverrides;
  const scopeError =
    scopeQuery.data?.error?.message ?? scopeQuery.error?.message;
  const ready =
    scope === "all" ||
    (!!scopeQuery.data?.data &&
      scopeQuery.data.generation === generation &&
      !scopeError);
  const courses = data.courses.filter(
    (c) =>
      (semester === "all" || `${c.xnd}-${c.xq}` === semester) &&
      (scope === "all" || countsAsMajor(c, overrides)),
  );
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await action({ kind: "setGradeScope", generation, ...draft });
      await scopeQuery.refetch();
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "范围未能保存");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="toolbar grade-scope-toolbar">
        <label>
          统计范围{" "}
          <select
            aria-label="成绩统计范围"
            value={scope}
            onChange={(e) => setScope(e.target.value as GradeScope)}
          >
            <option value="all">全部课程</option>
            <option value="major">专业必修与限选</option>
          </select>
        </label>
        {scope === "major" && (
          <Button
            variant="quiet"
            disabled={!ready}
            onClick={() => {
              setError("");
              setDraft(overrides);
            }}
          >
            调整课程范围
          </Button>
        )}
      </div>
      {scope === "major" && (
        <p className="subtle">
          默认按学校课程类别识别，可手动加入标为任选的专业课。此范围独立于培养方案归类，统计结果仅供参考。
        </p>
      )}
      {!ready ? (
        <p role="status">
          {scopeError ?? "正在读取专业课范围…"}
          {scopeError && (
            <Button onClick={() => void scopeQuery.refetch()}>重试</Button>
          )}
        </p>
      ) : (
        <>
          <GradeSummary
            data={data}
            semester={semester}
            scope={scope}
            overrides={overrides}
          />
          {courses.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>课程</th>
                    {semester === "all" && <th>学期</th>}
                    <th>类别</th>
                    <th className="numeric">学分</th>
                    <th className="numeric">成绩</th>
                  </tr>
                </thead>
                <tbody>
                  {courses.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <strong>{c.kcmc}</strong>
                      </td>
                      {semester === "all" && (
                        <td className="subtle">
                          {c.xnd} · {c.xq}
                        </td>
                      )}
                      <td className="subtle">{c.kclbmc}</td>
                      <td className="numeric">{c.xf || "—"}</td>
                      <td className="numeric">
                        <strong>{c.xqcj || "未公布"}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              {data.courses.length
                ? "当前范围没有课程"
                : "学校尚未返回成绩记录"}
            </Empty>
          )}
        </>
      )}
      <Modal
        open={draft !== null}
        title="调整专业课范围"
        description="按学期逐门选择；只影响本机成绩统计，按当前成绩账号保存。"
        onClose={() => setDraft(null)}
        dismissible={!busy}
      >
        <div className="grade-scope-list">
          {data.courses.map((c, i) => (
            <label
              className="grade-scope-course"
              key={`${gradeCourseKey(c)}:${i}`}
            >
              <input
                type="checkbox"
                checked={countsAsMajor(c, draft ?? overrides)}
                disabled={busy}
                onChange={(e) =>
                  setDraft(
                    setGradeIncluded(draft ?? overrides, c, e.target.checked),
                  )
                }
              />
              <span>
                <strong>{c.kcmc}</strong>
                <small>
                  {c.xnd} · 第 {c.xq} 学期 · {c.kclbmc || "未标注类别"} · {c.xf}{" "}
                  学分
                </small>
              </span>
            </label>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => setDraft(emptyGradeOverrides)}
          >
            恢复自动识别
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存范围"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
