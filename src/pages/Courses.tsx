import ReplayPlayer, { type Replay } from "../components/ReplayPlayer";
import { useEffect, useState } from "react";
import CourseNotices from "../components/CourseNotices";
import LearningGrades from "../components/LearningGrades";
import LocalMaterials from "../components/LocalMaterials";
import CourseReviews from "../components/CourseReviews";
import { ArrowLeft, BookOpen, ChevronRight, Play } from "lucide-react";
import { useResource, openOfficial, type Course } from "../lib/api";
import {
  Button,
  Empty,
  Resource,
  Search,
  AttachmentRow,
  type Login,
} from "../components/ui";
import { usePageParams } from "../lib/navigation";
export default function Courses({ login }: { login: Login }) {
  const courses = useResource<Course[]>({ kind: "allCourses" });
  const [search, setSearch] = useState("");
  const [params, navigate] = usePageParams("课程");
  const selected = params.get("course");
  if (selected) {
    return (
      <Resource
        title="课程"
        q={courses}
        login={login}
        service="course"
        className="resource-page"
      >
        {(data) => {
          const course = data.find((c) => c.id === selected);
          return course ? (
            <CourseDetail
              key={course.id}
              course={course}
              onClose={() => navigate({ course: null })}
              login={login}
            />
          ) : (
            <>
              <Button
                variant="quiet"
                onClick={() => navigate({ course: null })}
              >
                <ArrowLeft size={17} />
                返回课程
              </Button>
              <Empty>当前账号未找到这门课程，请返回列表刷新。</Empty>
            </>
          );
        }}
      </Resource>
    );
  }
  return (
    <>
      <header className="page-heading">
        <h1>课程</h1>
        <Button onClick={() => void openOfficial("course")}>打开教学网</Button>
      </header>
      <div className="toolbar">
        <Search value={search} onChange={setSearch} placeholder="搜索课程" />
      </div>
      <Resource
        title="我的课程"
        q={courses}
        login={login}
        service="course"
        className="resource-plain"
        heading={<span className="subtle">按学期查看</span>}
      >
        {(data) => {
          const grouped = new Map<string, Course[]>();
          for (const course of data.filter((c) =>
            c.name
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase()),
          )) {
            const term = course.semester?.trim() || "未标注学期";
            const group = grouped.get(term) ?? [];
            group.push(course);
            grouped.set(term, group);
          }
          const terms = [...grouped.entries()].sort(([a], [b]) => {
            if (a === "未标注学期") return 1;
            if (b === "未标注学期") return -1;
            return b.localeCompare(a, "zh-CN", { numeric: true });
          });
          return terms.length ? (
            <div className="course-semesters">
              {terms.map(([term, rows], termIndex) => (
                <section
                  className="course-semester"
                  key={term}
                  aria-label={term}
                >
                  <details
                    className="semester-group"
                    key={search.trim() ? `search-${term}` : term}
                    open={!!search.trim() || termIndex === 0}
                  >
                    <summary className="course-semester-heading">
                      <h3>{term}</h3>
                      <span>{rows.length} 门课程</span>
                    </summary>
                    <div className="course-grid">
                      {rows.map((c) => (
                        <button
                          className="course-tile"
                          key={c.id}
                          onClick={() => navigate({ course: c.id })}
                        >
                          <h4>{c.name}</h4>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </details>
                </section>
              ))}
            </div>
          ) : (
            <Empty icon={<BookOpen />}>
              {search ? "没有匹配的课程" : "暂无课程"}
            </Empty>
          );
        }}
      </Resource>
    </>
  );
}
function CourseDetail({
  course,
  onClose,
  login,
}: {
  course: Course;
  onClose: () => void;
  login: Login;
}) {
  const [params, navigate] = usePageParams("课程");
  const tab = params.get("tab") ?? "videos";
  const setTab = (value: string) => navigate({ tab: value, video: null });
  const [search, setSearch] = useState("");

  return (
    <section className="course-detail">
      <header className="page-heading course-page-heading">
        <div>
          <Button variant="quiet" className="back-link" onClick={onClose}>
            <ArrowLeft size={17} />
            课程
          </Button>
          <h1>{course.name}</h1>
        </div>
        <div className="heading-actions">
          <CourseReviews course={course.name} />
          <Button variant="quiet" onClick={() => void openOfficial("course")}>
            打开教学网
          </Button>
        </div>
      </header>
      <div className="tabs">
        <button
          className={tab === "notices" ? "active" : ""}
          onClick={() => setTab("notices")}
        >
          课程通知
        </button>
        <button
          className={tab === "materials" ? "active" : ""}
          onClick={() => setTab("materials")}
        >
          课程资料
        </button>
        <button
          className={tab === "videos" ? "active" : ""}
          onClick={() => setTab("videos")}
        >
          课程回放
        </button>
        <button
          className={tab === "grades" ? "active" : ""}
          onClick={() => setTab("grades")}
        >
          教学网成绩
        </button>
      </div>
      {tab === "materials" ? (
        <>
          <Search value={search} onChange={setSearch} placeholder="搜索资料" />
          <LocalMaterials course={course.id} search={search} login={login} />
        </>
      ) : tab === "notices" ? (
        <CourseNotices course={course.id} login={login} />
      ) : tab === "grades" ? (
        <LearningGrades course={course.id} login={login} />
      ) : (
        <Videos course={course} login={login} />
      )}
    </section>
  );
}

function Videos({ course, login }: { course: Course; login: Login }) {
  const q = useResource<Replay[]>({ kind: "videos", course: course.id });
  const [playing, setPlaying] = useState<{
    video: Replay;
    generation: string;
  }>();
  const [params, navigate] = usePageParams("课程");
  const videoId = params.get("video");
  useEffect(() => {
    setPlaying((current) => {
      if (!videoId) return undefined;
      // A list refresh must not end an already-open playback session. Keep its
      // snapshot until navigation or an account change selects another session.
      const generation = q.data?.generation;
      if (
        current?.video.hash_id === videoId &&
        (!generation || current.generation === generation)
      )
        return current;
      const video = q.data?.data?.find((item) => item.hash_id === videoId);
      return video ? { video, generation: generation ?? "" } : undefined;
    });
  }, [videoId, q.data?.data, q.data?.generation]);
  return (
    <>
      {playing && (
        <ReplayPlayer
          key={`${course.id}:${playing.video.hash_id}:${playing.generation}`}
          course={course.id}
          video={playing.video}
          generation={playing.generation}
          close={() => {
            setPlaying(undefined);
            navigate({ video: null });
          }}
        />
      )}
      {!playing && (
        <Resource
          title="课程回放"
          q={q}
          login={login}
          service="course"
          officialTarget="course"
          className="resource-plain"
          heading={
            <span className="subtle">{q.data?.data?.length ?? 0} 节回放</span>
          }
        >
          {(videos) =>
            videos.length ? (
              <div className="video-list">
                {videos.map((v) => (
                  <AttachmentRow
                    key={v.hash_id}
                    file={{ name: replayLabel(v) }}
                    icon={<Play size={18} />}
                    request={{
                      kind: "downloadVideo",
                      course: course.id,
                      video: v.hash_id,
                    }}
                    extra={
                      <Button
                        variant="primary"
                        onClick={() => navigate({ video: v.hash_id })}
                      >
                        播放
                      </Button>
                    }
                  />
                ))}
              </div>
            ) : (
              <Empty>该课程回放列表暂未列出视频，可在教学网核对。</Empty>
            )
          }
        </Resource>
      )}
    </>
  );
}

function replayLabel(video: Replay) {
  const match = video.title.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (match)
    return `${Number(match[2])}月${Number(match[3])}日${match[4] ? ` · ${match[4]}` : ""}`;
  const date = video.time.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return date
    ? `${Number(date[2])}月${Number(date[3])}日 · ${video.title}`
    : video.title;
}
