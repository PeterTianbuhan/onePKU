import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GraduationCap } from "lucide-react";
import { action, useResource, type Course } from "../lib/api";
import type { Scores } from "../lib/grades";
import {
  computeProgress,
  directionSplits,
  directionsFor,
  IGNORE,
  inferProfile,
  loadPlan,
  normalizeCourseName,
  planIndex,
  planIndexMeta,
  sectionChoices,
  type MatchedCourse,
  type Progress,
  type ProgressSection,
} from "../lib/curriculum";
import {
  emptyProfile,
  normalizeProfile,
  overridesForPlan,
  saveProfile,
  useProfile,
  type Profile,
} from "../lib/profile";
import ProfileForm from "../components/ProfileForm";
import CurriculumRing from "../components/CurriculumRing";
import CurriculumSource from "../components/CurriculumSource";
import { Button, Empty, type Login } from "../components/ui";

const viaLabel: Record<NonNullable<MatchedCourse["via"]>, string> = {
  name: "课程名匹配",
  alternative: "可替代课程",
  variant: "同名实验班/变体",
  keyword: "按公共课关键词",
  category: "按成绩类别",
  override: "手动归类",
};
const statusLabel: Record<MatchedCourse["status"], string> = {
  passed: "已获",
  failed: "未通过",
  inProgress: "在修",
  withdrawn: "退课",
  other: "其他",
};

function requirementText(s: ProgressSection) {
  if (s.requirement) return s.requirement;
  if (s.min === undefined) return "";
  const unit = s.unit ?? "学分";
  return s.max !== undefined && s.max !== s.min
    ? `${s.min}～${s.max} ${unit}`
    : `${s.min} ${unit}`;
}
function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
/** 圆环与缺口用的数值：学分系列按学分，门数系列按已通过门数。 */
function measure(s: ProgressSection) {
  if (s.unit === "门") return { value: s.passedCount, pending: 0, unit: "门" };
  if (s.unit === "学时")
    return { value: s.earned, pending: s.inProgress, unit: "学时" };
  return { value: s.earned, pending: s.inProgress, unit: "学分" };
}
/** 这一类（含其子类）里有没有教学网的在修课程。 */
function holdsInProgress(s: ProgressSection): boolean {
  return (
    s.courses.some((c) => c.status === "inProgress") ||
    s.children.some(holdsInProgress)
  );
}
function gap(s: ProgressSection) {
  if (s.min === undefined || s.unit === "学时") return null;
  const m = measure(s);
  return Math.max(0, s.min - m.value - m.pending);
}
/** 「恢复自动判断」的哨兵，不会与真实系列 id 冲突。 */
const AUTO = "__auto__";
/** 只认数字与小数点，最多五位；清空表示不再手填。 */
function parseCredits(raw: string): number | null {
  const text = raw
    .replace(/[^0-9.]/g, "")
    .slice(0, 5)
    .replace(/\.?$/, "");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
type Editor = {
  choices: { id: string; label: string }[];
  pinned: Record<string, string>;
  onCredit: (name: string, credits: number | null) => void;
  onOverride: (key: string, sectionId: string | null) => void;
};
function gapText(s: ProgressSection) {
  const g = gap(s);
  if (g === null) return "";
  return g === 0 ? "已满足" : `还差 ${fmt(g)} ${measure(s).unit}`;
}
/** 手填学分以规范化课程名为键；清空就是不再手填，回到成绩或方案的口径。 */
function withManualCredit(
  saved: Profile,
  name: string,
  credits: number | null,
): Profile {
  const manualCredits = { ...saved.manualCredits };
  const key = normalizeCourseName(name);
  if (credits === null) delete manualCredits[key];
  else manualCredits[key] = credits;
  return { ...saved, manualCredits };
}
/** 方向选择按「<方案 id>|<系列 id>」存，主修与双学位各写各的键。 */
function withDirection(
  saved: Profile,
  planId: string,
  sectionId: string,
  groupId: string | null,
): Profile {
  const directions = { ...saved.directions };
  const key = `${planId}|${sectionId}`;
  if (groupId) directions[key] = groupId;
  else delete directions[key];
  return { ...saved, directions };
}

export default function Curriculum({
  login,
  navigate,
}: {
  login: Login;
  navigate: (page: string) => void;
}) {
  const profileQuery = useProfile();
  const scores = useResource<Scores>({ kind: "scores" });
  const courses = useResource<Course[]>({ kind: "allCourses" });
  const saved = normalizeProfile(profileQuery.data?.data ?? null);
  const scoreRows = scores.data?.data?.courses ?? [];
  const courseRows = courses.data?.data ?? [];
  // 教学网没读到课程时，培养方案会安静地少算每一门在修课——必须说出来。
  const courseError =
    courses.data?.error?.message ?? courses.error?.message ?? "";
  const courseNote = courseRows.length
    ? ""
    : courseError
      ? `教学网课程未能读取：${courseError}。在修课程无法计入。`
      : courses.isFetching
        ? "正在读取教学网本学期课程…"
        : "教学网没有返回任何课程，在修课程无法计入。";
  const college = useResource<{
    selected: string;
    detected: string;
    effective: string;
    options: string[];
  }>({ kind: "departments" });
  // 手动选择优先，其次用校内门户识别到的单位。
  const department = college.data?.data?.effective || null;
  const inference = useMemo(
    () => inferProfile(scoreRows, courseRows, planIndex, department),
    [scoreRows, courseRows, department],
  );
  const [draft, setDraft] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const loaded = profileQuery.data !== undefined;
  const editing = loaded && (saved === null || draft !== null);

  useEffect(() => {
    if (!loaded || saved || draft) return;
    if (scores.isPending || courses.isPending) return;
    const top = inference.candidates[0];
    setDraft({
      ...emptyProfile,
      cohort: inference.cohort,
      planId: top?.id ?? null,
      inferred: Boolean(top),
    });
  }, [loaded, saved, draft, inference, scores.isPending, courses.isPending]);

  async function persist(next: Profile) {
    setSaving(true);
    setError("");
    try {
      await saveProfile(next);
      await profileQuery.refetch();
      setDraft(null);
    } catch {
      setError("资料未能保存，请重试");
    } finally {
      setSaving(false);
    }
  }

  const missingLogin = (
    <div className="curriculum-login-hints">
      {scores.data?.error?.code === "auth" ||
      (!scores.data?.data && !scores.isPending) ? (
        <p>
          成绩来自树洞接口。
          <button className="text-button" onClick={() => login("treehole")}>
            连接树洞
          </button>
          后可以自动推断年级与专业，并计算已获学分。
        </p>
      ) : null}
      {courses.data?.error?.code === "auth" ||
      (!courses.data?.data && !courses.isPending) ? (
        <p>
          在修课程来自教学网。
          <button className="text-button" onClick={() => login("course")}>
            连接教学网
          </button>
          后可以看到本学期在修学分。
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>培养方案</h1>
          <p className="page-subtitle">
            按教务部公开的培养方案计算学分完成情况，以学校毕业审查为准。
          </p>
        </div>
        {saved && !editing && (
          <Button variant="quiet" onClick={() => setDraft({ ...saved })}>
            修改年级与专业
          </Button>
        )}
      </header>
      {!loaded ? (
        <div className="skeleton" aria-label="正在读取资料">
          <i />
          <i />
        </div>
      ) : editing ? (
        <section className="resource settings-section onboarding">
          <h2>{saved ? "修改年级与专业" : "先确认年级与专业"}</h2>
          {!saved && (
            <p className="section-description">
              只需确认三项信息，之后随时可以在设置里修改。资料只保存在这台电脑上。
            </p>
          )}
          {inference.evidence.length > 0 && (
            <ul className="inference-evidence">
              {inference.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {missingLogin}
          {draft ? (
            <ProfileForm
              value={draft}
              onChange={setDraft}
              inference={inference}
            />
          ) : (
            <div className="skeleton" aria-label="正在推断年级与专业">
              <i />
            </div>
          )}
          <div className="submission-actions">
            <Button
              variant="primary"
              disabled={saving || !draft || !draft.planId}
              onClick={() => draft && void persist(draft)}
            >
              保存
            </Button>
            {saved ? (
              <Button variant="quiet" onClick={() => setDraft(null)}>
                取消
              </Button>
            ) : (
              <Button
                variant="quiet"
                disabled={saving || !draft}
                onClick={() =>
                  draft && void persist({ ...draft, planId: null })
                }
              >
                稍后再说
              </Button>
            )}
            {draft && !draft.planId && (
              <span className="subtle">选择专业后才能计算完成情况</span>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      ) : saved && !saved.planId ? (
        <Empty icon={<GraduationCap />}>
          尚未选择培养方案。
          <button
            className="text-button"
            onClick={() => setDraft({ ...saved })}
          >
            选择年级与专业
          </button>
        </Empty>
      ) : saved ? (
        <>
          {missingLogin}
          <PlanProgress
            planId={saved.planId!}
            profile={saved}
            scoreRows={scoreRows}
            courseRows={courseRows}
            courseNote={courseNote}
            onOverride={(key, sectionId) => {
              const overrides = { ...saved.overrides };
              if (sectionId) overrides[key] = sectionId;
              else delete overrides[key];
              void persist({ ...saved, overrides });
            }}
            onDirection={(sectionId, groupId) =>
              void persist(
                withDirection(saved, saved.planId!, sectionId, groupId),
              )
            }
            onCredit={(name, credits) =>
              void persist(withManualCredit(saved, name, credits))
            }
          />
          {saved.secondaryPlanId && (
            <PlanProgress
              planId={saved.secondaryPlanId}
              profile={saved}
              scoreRows={scoreRows}
              courseRows={courseRows}
              courseNote={courseNote}
              secondary
              onOverride={(key, sectionId) => {
                const overrides = { ...saved.overrides };
                if (sectionId)
                  overrides[`${saved.secondaryPlanId}:${key}`] = sectionId;
                else delete overrides[`${saved.secondaryPlanId}:${key}`];
                void persist({ ...saved, overrides });
              }}
              onDirection={(sectionId, groupId) =>
                void persist(
                  withDirection(
                    saved,
                    saved.secondaryPlanId!,
                    sectionId,
                    groupId,
                  ),
                )
              }
              onCredit={(name, credits) =>
                void persist(withManualCredit(saved, name, credits))
              }
            />
          )}
          <p className="subtle curriculum-footnote">
            数据来自教务部公开 PDF（索引更新于 {planIndexMeta.generatedAt}
            ），由社区整理，可能有误。
            <button
              className="text-button"
              onClick={() =>
                void action({ kind: "openLink", url: planIndexMeta.source })
              }
            >
              教务部培养方案页
            </button>
            ·
            <button className="text-button" onClick={() => navigate("设置")}>
              在设置中修改资料
            </button>
          </p>
        </>
      ) : null}
    </>
  );
}

function PlanProgress({
  planId,
  profile,
  scoreRows,
  courseRows,
  courseNote,
  secondary = false,
  onOverride,
  onDirection,
  onCredit,
}: {
  planId: string;
  profile: Profile;
  scoreRows: Scores["courses"];
  courseRows: Course[];
  courseNote: string;
  secondary?: boolean;
  onOverride: (key: string, sectionId: string | null) => void;
  onDirection: (sectionId: string, groupId: string | null) => void;
  onCredit: (name: string, credits: number | null) => void;
}) {
  const plan = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => loadPlan(planId),
    staleTime: Infinity,
  });
  const entry = planIndex.find((p) => p.id === planId);
  const overrides = useMemo(
    () => overridesForPlan(profile, planId),
    [profile, planId],
  );
  const progress = useMemo(
    () =>
      plan.data
        ? computeProgress(plan.data, scoreRows, courseRows, overrides, {
            englishLevel: profile.englishLevel,
            directions: directionsFor(planId, profile.directions),
            manualCredits: profile.manualCredits,
          })
        : null,
    [
      plan.data,
      scoreRows,
      courseRows,
      overrides,
      profile.englishLevel,
      profile.directions,
      profile.manualCredits,
      planId,
    ],
  );
  if (plan.isPending)
    return (
      <div className="skeleton" aria-label="正在读取培养方案">
        <i />
        <i />
      </div>
    );
  if (plan.error || !progress)
    return (
      <section className="resource">
        <p role="alert">
          培养方案“{entry?.title ?? planId}”未能读取，请重新选择专业。
        </p>
      </section>
    );
  return (
    <ProgressView
      progress={progress}
      courseNote={courseNote}
      secondary={secondary}
      englishChosen={profile.englishLevel !== null}
      directions={directionsFor(planId, profile.directions)}
      pinned={overrides}
      onDirection={onDirection}
      onCredit={onCredit}
      onOverride={onOverride}
    />
  );
}

function ProgressView({
  progress,
  courseNote,
  secondary,
  englishChosen,
  directions,
  pinned,
  onDirection,
  onCredit,
  onOverride,
}: {
  progress: Progress;
  courseNote: string;
  secondary: boolean;
  englishChosen: boolean;
  directions: Record<string, string>;
  pinned: Record<string, string>;
  onDirection: (sectionId: string, groupId: string | null) => void;
  onCredit: (name: string, credits: number | null) => void;
  onOverride: (key: string, sectionId: string | null) => void;
}) {
  const { plan, sections, pending, ignored, totals } = progress;
  const splits = directionSplits(plan);
  const choices = sectionChoices(progress);
  const editor: Editor = { choices, pinned, onCredit, onOverride };
  const unknownCourses = sections
    .flatMap((s) => [s, ...s.children])
    .flatMap((s) => s.courses)
    .filter((c) => c.credits === null && c.status === "passed");
  const [selected, setSelected] = useState<string>("total");
  const [sourceOpen, setSourceOpen] = useState(false);
  const inferredTitle = plan.titleInference;
  const totalGap =
    totals.required !== null
      ? Math.max(0, totals.required - totals.earned - totals.inProgress)
      : null;
  const current =
    selected === "total" ? null : sections.find((s) => s.id === selected);
  const hasEnglishRange = sections.some((s) =>
    s.children.some(
      (c) => /英语/.test(c.name) && c.min !== undefined && c.min !== c.max,
    ),
  );
  const pageLabels = plan.source.pageLabels;
  return (
    <section
      className={`resource curriculum-plan ${secondary ? "secondary" : ""}`}
      aria-label={`${secondary ? "双学位方案" : "主修方案"}：${plan.title}`}
    >
      <div className="resource-heading">
        <div>
          <h2>
            {secondary ? "双学位 / 辅修：" : ""}
            {plan.school} · {plan.title}
          </h2>
          <p className="subtle">
            {plan.volume}
            {plan.degree ? ` · ${plan.degree}` : ""}
            {inferredTitle
              ? ` · 专业名按 ${inferredTitle.from} 版推断，请核对`
              : ""}
          </p>
        </div>
        <Button variant="quiet" onClick={() => setSourceOpen(true)}>
          原文 PDF
          {pageLabels ? ` · 书页 ${pageLabels[0]}–${pageLabels[1]}` : ""}
        </Button>
      </div>
      <CurriculumSource
        plan={plan}
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
      />
      {splits.length > 0 && (
        <div className="toolbar">
          {splits.map((split) => (
            <label key={split.sectionId}>
              <span className="subtle">{split.name}方向</span>
              <select
                aria-label={`${split.name}按哪个方向计算`}
                value={directions[split.sectionId] ?? ""}
                onChange={(e) =>
                  onDirection(split.sectionId, e.target.value || null)
                }
              >
                <option value="">未选择方向</option>
                {split.options.map((option) => (
                  <option key={option.groupId} value={option.groupId}>
                    {option.name} · {fmt(option.min)} 学分
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      <div className="ring-grid" role="tablist" aria-label="学分系列">
        <RingCard
          id="total"
          name="毕业总学分"
          value={totals.earned}
          pending={totals.inProgress}
          target={totals.required}
          unit="学分"
          detail={
            totals.required === null
              ? "方案未标注总学分"
              : totalGap === 0
                ? "已满足"
                : `在修 ${fmt(totals.inProgress)} · 还差 ${fmt(totalGap!)}`
          }
          selected={selected === "total"}
          onSelect={() => setSelected("total")}
        />
        {sections.map((s) => {
          const m = measure(s);
          return (
            <RingCard
              key={s.id}
              id={s.id}
              name={s.name}
              value={m.value}
              pending={m.pending}
              target={s.min ?? null}
              unit={m.unit}
              detail={
                s.min === undefined
                  ? "方案未标注要求"
                  : m.pending
                    ? `在修 ${fmt(m.pending)} · ${gapText(s)}`
                    : gapText(s)
              }
              selected={selected === s.id}
              onSelect={() => setSelected(s.id)}
            />
          );
        })}
      </div>
      {courseNote && (
        <p className="subtle curriculum-hint" role="status">
          {courseNote}
        </p>
      )}
      {totals.unknownCredits > 0 && (
        <p className="subtle">
          已归类课程中有 {totals.unknownCredits}{" "}
          门已通过的课学分未知，未计入合计：
          {unknownCourses.map((c) => c.name).join("、")}。
          学分优先取成绩记录，缺失时取当前方案的匹配课程。
        </p>
      )}
      {hasEnglishRange && !englishChosen && (
        <p className="subtle curriculum-hint">
          大学英语按分级修 2～8
          学分。在“修改年级与专业”里选择你的英语分级后，这里会按分级固定英语学分，大类总额随之按各子系列求和。
        </p>
      )}
      {/* 「待确认」放在卡片下面，不跟着圆环切换。 */}
      {pending.length > 0 && (
        <div className="curriculum-pending">
          <h3>待确认（{pending.length}）</h3>
          <p className="subtle">
            这些课在方案课程表里没有同名条目，也无法按类别判断。归类只保存在本机，可随时改；归类不会自动补齐未知学分。
          </p>
          <ul>
            {pending.map((c) => (
              <li key={c.key}>
                <div className="grow">
                  <strong>{c.name}</strong>
                  <span className="subtle">
                    {c.term} · {c.category} · {statusLabel[c.status]}
                    {c.credits !== null
                      ? ` · ${fmt(c.credits)} 学分`
                      : " · 学分未知"}
                  </span>
                </div>
                <input
                  className="course-credit"
                  aria-label={`学分 ${c.name}`}
                  title="教学网在修课程列表不提供学分，手填后才计入合计"
                  inputMode="decimal"
                  placeholder="?"
                  defaultValue={c.credits ?? ""}
                  key={`pending:${c.key}:${c.credits ?? ""}`}
                  onBlur={(e) => onCredit(c.name, parseCredits(e.target.value))}
                />
                <select
                  aria-label={`归类 ${c.name}`}
                  value=""
                  onChange={(e) =>
                    e.target.value &&
                    onOverride(normalizeCourseName(c.name), e.target.value)
                  }
                >
                  <option value="">归入…</option>
                  {choices.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.label}
                    </option>
                  ))}
                  <option value={IGNORE}>不计入</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        className="section-detail"
        role="tabpanel"
        aria-label={current ? `${current.name}明细` : "全部学分系列明细"}
      >
        {current?.note && <p className="subtle detail-note">{current.note}</p>}
        {current ? (
          <>
            {current.children.map((c) => (
              <DetailRow key={c.id} section={c} autoOpen editor={editor} />
            ))}
            {(current.courses.length > 0 || current.children.length === 0) && (
              <>
                {current.children.length > 0 && (
                  <p className="subtle curriculum-hint">
                    本类直属课程（不含上面各系列的课）
                  </p>
                )}
                <CourseList courses={current.courses} editor={editor} />
              </>
            )}
          </>
        ) : (
          sections.map((s) => (
            <DetailRow key={s.id} section={s} top editor={editor} />
          ))
        )}
      </div>
      {ignored.length > 0 && (
        <details className="settings-explanation">
          <summary>不计入的记录（{ignored.length}）</summary>
          <ul className="curriculum-ignored">
            {ignored.map((c) => (
              <li key={c.key}>
                <span>
                  {c.name} · {c.term} · {statusLabel[c.status]}
                  {c.score ? ` · ${c.score}` : ""}
                </span>
                {c.via === "override" && (
                  <button
                    className="text-button"
                    onClick={() =>
                      onOverride(normalizeCourseName(c.name), null)
                    }
                  >
                    恢复
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(plan.notes.length > 0 || plan.warnings.length > 0) && (
        <details className="settings-explanation">
          <summary>
            方案原文备注与数据说明
            {plan.warnings.length
              ? `（${plan.warnings.length} 处解析警告）`
              : ""}
          </summary>
          {plan.notes.length > 0 && (
            <ul className="curriculum-notes">
              {plan.notes.slice(0, 40).map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {plan.warnings.length > 0 && (
            <>
              <p className="subtle">解析警告（可在仓库 overrides 中修正）：</p>
              <ul className="curriculum-notes">
                {plan.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
    </section>
  );
}

function RingCard({
  id,
  name,
  value,
  pending,
  target,
  unit,
  detail,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  value: number;
  pending: number;
  target: number | null;
  unit: string;
  detail: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const complete = target !== null && value >= target;
  return (
    <button
      type="button"
      role="tab"
      id={`ring-${id}`}
      aria-selected={selected}
      className={`ring-card ${selected ? "selected" : ""}`}
      onClick={onSelect}
    >
      <CurriculumRing
        value={value}
        pending={pending}
        target={target}
        complete={complete}
      >
        <strong>{fmt(value)}</strong>
        <small>{target !== null ? `/ ${fmt(target)}` : unit}</small>
      </CurriculumRing>
      <span className="ring-name">{name}</span>
      <span className={`ring-detail ${complete ? "complete" : ""}`}>
        {detail}
      </span>
    </button>
  );
}

function DetailRow({
  section,
  top = false,
  autoOpen = false,
  editor,
}: {
  section: ProgressSection;
  top?: boolean;
  /** 选中的类别下面直接摊开在修与已修，不用再点一次「N 门课」。 */
  autoOpen?: boolean;
  editor: Editor;
}) {
  // 含在修课的系列默认就展开：在修课没有学分、不进合计，折叠起来等于看不见。
  // 课往往记在子系列上，所以要看整棵子树。
  const [open, setOpen] = useState(autoOpen || holdsInProgress(section));
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  const m = measure(section);
  const target = section.min ?? null;
  const ratio = (n: number) => (target ? Math.min(100, (100 * n) / target) : 0);
  const g = gap(section);
  const complete = g === 0 && target !== null;
  const hasCourses = section.courses.length > 0;
  const hasChildren = section.children.length > 0;
  return (
    <div
      className={`detail-row ${top ? "top" : ""} ${complete ? "complete" : ""}`}
    >
      <div className="detail-main">
        <div className="detail-title">
          <span className="detail-name">{section.name}</span>
          {section.requirement || target !== null ? (
            <span className="subtle">{requirementText(section)}</span>
          ) : null}
          {section.note && <span className="subtle">· {section.note}</span>}
        </div>
        <div className="detail-bar" aria-hidden="true">
          <i
            className="pending"
            style={{ width: `${ratio(m.value + m.pending)}%` }}
          />
          <i className="done" style={{ width: `${ratio(m.value)}%` }} />
        </div>
      </div>
      <div className="detail-numbers">
        <strong>{fmt(m.value)}</strong>
        <span className="subtle">
          {target !== null ? ` / ${fmt(target)} ${m.unit}` : ` ${m.unit}`}
        </span>
        {m.pending > 0 && (
          <span className="subtle"> · 在修 {fmt(m.pending)}</span>
        )}
        <span className={`detail-gap ${complete ? "complete" : ""}`}>
          {gapText(section)}
        </span>
      </div>
      {section.note && <p className="subtle detail-note">{section.note}</p>}
      {(hasCourses || hasChildren) && (
        <button
          type="button"
          className="text-button detail-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open
            ? "收起"
            : hasChildren
              ? hasCourses
                ? `${section.children.length} 个系列 · ${section.courses.length} 门课`
                : `${section.children.length} 个系列`
              : `${section.courses.length} 门课`}
        </button>
      )}
      {open && hasChildren && (
        <div className="detail-children">
          {section.children.map((c) => (
            <DetailRow key={c.id} section={c} editor={editor} />
          ))}
        </div>
      )}
      {open && hasCourses && (
        <>
          {hasChildren && (
            <p className="subtle curriculum-hint">
              本类直属课程（不含上面各系列的课）
            </p>
          )}
          <CourseList courses={section.courses} editor={editor} />
        </>
      )}
    </div>
  );
}

function CourseList({
  courses,
  editor,
}: {
  courses: MatchedCourse[];
  editor: Editor;
}) {
  if (courses.length === 0)
    return <p className="subtle course-list-empty">这一类暂无计入的课程。</p>;
  const doing = courses.filter((c) => c.status === "inProgress");
  const done = courses.filter((c) => c.status !== "inProgress");
  const missing = doing.filter((c) => c.credits === null).length;
  const row = (c: MatchedCourse) => {
    const key = normalizeCourseName(c.name);
    const pinned = editor.pinned[key];
    return (
      <li key={c.key}>
        <span className="course-name">{c.name}</span>
        <span className="subtle">
          {c.term}
          {c.via ? ` · ${viaLabel[c.via]}` : ""}
        </span>
        <span className={`course-status ${c.status}`}>
          {statusLabel[c.status]}
          {c.score && c.status !== "inProgress" ? ` ${c.score}` : ""}
        </span>
        <input
          className="course-credit"
          aria-label={`学分 ${c.name}`}
          title={
            c.credits === null
              ? c.status === "inProgress"
                ? "教学网在修课程列表不提供学分，手填后才计入合计"
                : "成绩记录与当前培养方案均未提供可用学分"
              : "手填学分以这里为准，清空即回到成绩或方案的口径"
          }
          inputMode="decimal"
          placeholder="?"
          defaultValue={c.credits ?? ""}
          key={`${c.key}:${c.credits ?? ""}`}
          onBlur={(e) => editor.onCredit(c.name, parseCredits(e.target.value))}
        />
        <select
          aria-label={`归类 ${c.name}`}
          value={pinned ?? AUTO}
          onChange={(e) =>
            editor.onOverride(
              key,
              e.target.value === AUTO ? null : e.target.value,
            )
          }
        >
          <option value={AUTO}>按方案自动</option>
          {editor.choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
          <option value={IGNORE}>不计入</option>
        </select>
      </li>
    );
  };
  return (
    <>
      {missing > 0 && (
        <p className="subtle curriculum-hint">
          在修 {doing.length} 门里有 {missing} 门没填学分，填了才计入合计。
        </p>
      )}
      <ul className="course-list">
        {doing.length > 0 && (
          <li className="course-group">在修课程 {doing.length} 门</li>
        )}
        {doing.map(row)}
        {done.length > 0 && (
          <li className="course-group">已修课程 {done.length} 门</li>
        )}
        {done.map(row)}
      </ul>
    </>
  );
}
