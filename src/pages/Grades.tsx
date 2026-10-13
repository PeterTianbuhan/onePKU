import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { useResource, openOfficial, action } from "../lib/api";
import { Button, Empty, Resource, type Login } from "../components/ui";
import {
  calculateGrades,
  emptyScopeOverride,
  gradeScopeLabels,
  inScope,
  normalizeScope,
  officialGpa,
  gradeRulesUrl,
  toggleScope,
  type GradeCourse,
  type GradeScope,
  type Scores,
  type ScopeOverride,
} from "../lib/grades";

function GradeSummary({
  data,
  scope,
  override,
}: {
  data: Scores;
  scope: GradeScope;
  override: ScopeOverride;
}) {
  const [openError, setOpenError] = useState("");
  const courses = data.courses;
  const calculated = calculateGrades(courses, scope, override);
  // 学校只返回全部课程的累计 GPA，专业口径只能本地算。
  const official = scope === "major" ? null : officialGpa(data.overall_gpa);
  const gpa = official ?? calculated.gpa;
  return (
    <>
      <div className="study-metrics grade-metrics">
        <div>
          <div className="grade-label">
            <span>{gradeScopeLabels[scope]} · 累计 GPA</span>
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
                  GPA 按北大本科规则、平均分按学分加权。
                  {scope === "major"
                    ? "专业口径只统计课程类别含「专业必修」或「专业限选」的课，手动调整以纳入的为准。"
                    : ""}
                  当前纳入 {calculated.included} 条成绩，共 {calculated.credits}{" "}
                  学分。
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
          <span>{official !== null ? "学校返回" : "按官方规则计算"}</span>
        </div>
        <div>
          <span>学分加权平均分</span>
          <strong>{calculated.average?.toFixed(2) ?? "—"}</strong>
          <span>本地计算</span>
        </div>
        <div>
          <span>累计已获学分</span>
          <strong>{data.total_credits || "—"}</strong>
          <span>学校返回</span>
        </div>
      </div>
    </>
  );
}

export default function Grades({ login }: { login: Login }) {
  const scores = useResource<Scores>({ kind: "scores" });
  const stored = useResource<ScopeOverride>({ kind: "gradesScope" });
  const override = normalizeScope(stored.data?.data);
  const [scope, setScope] = useState<GradeScope>("all");
  const [editing, setEditing] = useState(false);
  function adjust(course: GradeCourse, want: boolean) {
    void action({
      kind: "setGradesScope",
      scope: toggleScope(override, course, want),
    }).then(() => void stored.refetch());
  }
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
          <div className="grade-tools">
            <div className="tabs" role="tablist" aria-label="成绩口径">
              {(["all", "major"] as GradeScope[]).map((item) => (
                <button
                  key={item}
                  role="tab"
                  aria-selected={scope === item}
                  className={scope === item ? "active" : ""}
                  onClick={() => {
                    setScope(item);
                    setEditing(item === "major");
                  }}
                >
                  {gradeScopeLabels[item]}
                </button>
              ))}
            </div>
            {scope === "major" && (
              <Button
                variant="quiet"
                onClick={() =>
                  void action({
                    kind: "setGradesScope",
                    scope: emptyScopeOverride,
                  }).then(() => void stored.refetch())
                }
                disabled={
                  !override.included.length && !override.excluded.length
                }
              >
                恢复自动口径
              </Button>
            )}
          </div>
        }
        q={scores}
        login={login}
        service="treehole"
      >
        {(data) => (
          <>
            <GradeSummary data={data} scope={scope} override={override} />
            {data.courses.length ? (
              terms.map((term) => {
                const rows = data.courses.filter(
                  (c) => `${c.xnd}-${c.xq}` === term,
                );
                const termStats = calculateGrades(rows, scope, override);
                // 每学期先用学校给的 GPA，专业口径与缺失时本地计算。
                const official =
                  scope === "major"
                    ? null
                    : officialGpa(
                        data.semester_gpas.find((s) => s.xndxq === term)?.gpa,
                      );
                const gpa = official ?? termStats.gpa;
                return (
                  <section
                    key={term}
                    className="grade-term"
                    aria-label={term.replace(/-(\d)$/, " 学年第$1学期")}
                  >
                    <h3>
                      {term.replace(/-(\d)$/, " 学年第$1学期")}
                      <span className="subtle">
                        GPA {gpa?.toFixed(2) ?? "—"} · 平均{" "}
                        {termStats.average?.toFixed(2) ?? "—"}
                      </span>
                    </h3>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>课程</th>
                            <th>类别</th>
                            <th className="numeric">学分</th>
                            <th className="numeric">成绩</th>
                            {editing && <th className="numeric">计入专业</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((c, i) => (
                            <tr key={i}>
                              <td>
                                <strong>{c.kcmc}</strong>
                              </td>
                              <td className="subtle">{c.kclbmc}</td>
                              <td className="numeric">{c.xf || "—"}</td>
                              <td className="numeric">
                                <strong>{c.xqcj || "未公布"}</strong>
                              </td>
                              {editing && (
                                <td className="numeric">
                                  <input
                                    type="checkbox"
                                    aria-label={`计入专业成绩 ${c.kcmc} ${c.xnd}-${c.xq}`}
                                    checked={inScope(c, "major", override)}
                                    onChange={(e) =>
                                      adjust(c, e.target.checked)
                                    }
                                  />
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })
            ) : (
              <Empty>学校尚未返回成绩记录</Empty>
            )}
          </>
        )}
      </Resource>
    </>
  );
}
