import { assignmentNeedsFile, type Assignment } from "../lib/api";
import AssignmentFeedback from "./AssignmentFeedback";
import { AttachmentRow, type Login } from "./ui";
import Submission from "./Submission";

export function AssignmentDetails({
  assignment: a,
  login = () => {},
}: {
  assignment: Assignment;
  login?: Login;
}) {
  const instructions = (
    <>
      {a.descriptions.map((p, i) => (
        <p className="prose" key={i}>
          {p}
        </p>
      ))}
      {a.attachments
        .filter((f) => f.name.trim())
        .map((f, i) => (
          <AttachmentRow key={i} file={f} course={a.course_id} />
        ))}
    </>
  );
  return (
    <div className="assignment-detail">
      <p className="subtle">{a.course_name}</p>
      <h1>{a.title}</h1>
      {(a.deadline_raw || a.detail_error || !assignmentNeedsFile(a)) && (
        <div className="detail-meta">
          {a.deadline_raw}
          {!assignmentNeedsFile(a) && <span>无需提交文件</span>}
          {a.detail_error && (
            <>
              <br />
              详情或提交状态暂未获取，请刷新或在教学网确认
            </>
          )}
        </div>
      )}
      {a.last_attempt ? (
        <>
          <AssignmentFeedback assignment={a} login={login} />
          <details className="assignment-instructions">
            <summary>作业说明与附件</summary>
            {instructions}
          </details>
        </>
      ) : (
        <>
          {instructions}
          <AssignmentFeedback assignment={a} login={login} />
        </>
      )}
      <Submission assignment={a} />
    </div>
  );
}
