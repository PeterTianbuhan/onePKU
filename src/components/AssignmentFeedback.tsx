import { useState } from "react";
import { FileText } from "lucide-react";
import { useResource, type Assignment, type Attachment } from "../lib/api";
import { openBrowser } from "../lib/browser";
import { AttachmentRow, Button, Resource, type Login } from "./ui";
type Link = { name: string; url: string };
type Attempt = {
  id: string;
  label: string;
  score: string | null;
  pointsPossible: string | null;
  feedback: string | null;
  files: Attachment[];
  feedbackLinks: Link[];
  url: string;
  unavailable: boolean;
};
type Feedback = { attempts: Attempt[]; url: string };
export default function AssignmentFeedback({
  assignment,
  login,
}: {
  assignment: Assignment;
  login: Login;
}) {
  const q = useResource<Feedback>({
    kind: "assignmentFeedback",
    course: assignment.course_id,
    content: assignment.content_id,
  });
  const [error, setError] = useState("");
  async function open(url: string, title: string) {
    setError("");
    try {
      await openBrowser(url, title);
    } catch {
      setError("教学网窗口未能打开，请重试");
    }
  }
  return (
    <section className="assignment-feedback">
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <Resource
        title="评分与反馈"
        q={q}
        service="course"
        login={login}
        className={
          (q.data?.data?.attempts ?? []).length ? "" : "feedback-compact"
        }
      >
        {(data) =>
          (data.attempts ?? []).length ? (
            <div className="feedback-history">
              {data.attempts.map((a, i) => (
                <details key={a.id} open={i === 0} className="feedback-attempt">
                  <summary>
                    <span>{a.label}</span>
                    <strong className={a.score == null ? "subtle" : ""}>
                      {a.unavailable
                        ? "未能读取"
                        : a.score == null
                          ? "未评分"
                          : `${a.score}${a.pointsPossible ? ` / ${a.pointsPossible}` : ""}`}
                    </strong>
                  </summary>
                  <div className="feedback-body">
                    {a.unavailable ? (
                      <p className="inline-error">
                        这次提交记录未能更新，请刷新或在教学网查看。
                      </p>
                    ) : (
                      <>
                        {a.feedback ? (
                          <p className="prose">{a.feedback}</p>
                        ) : (
                          <p className="subtle">暂无文字反馈</p>
                        )}
                        {!!a.feedbackLinks.length && (
                          <div className="feedback-links">
                            {a.feedbackLinks.map((f, i) => (
                              <Button
                                key={i}
                                variant="quiet"
                                onClick={() => void open(f.url, f.name)}
                              >
                                <FileText size={16} />
                                {f.name}
                              </Button>
                            ))}
                          </div>
                        )}
                        {!!a.files.length && (
                          <div className="feedback-files">
                            <span className="subtle">已交文件</span>
                            {a.files.map((f, i) => (
                              <AttachmentRow
                                key={i}
                                file={f}
                                course={assignment.course_id}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <Button
                      variant="quiet"
                      onClick={() => void open(a.url, assignment.title)}
                    >
                      在教学网查看
                    </Button>
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <p className="subtle feedback-empty">暂无提交记录</p>
          )
        }
      </Resource>
    </section>
  );
}
