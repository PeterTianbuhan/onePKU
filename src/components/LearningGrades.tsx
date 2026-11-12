import { useResource } from "../lib/api";
import { Empty, Resource, type Login } from "./ui";
type Grade = {
  id: string;
  title: string;
  category: string;
  score: string;
  activity: string;
  updated: string;
  status: string;
};
export default function LearningGrades({
  course,
  login,
}: {
  course: string;
  login: Login;
}) {
  const q = useResource<Grade[]>({ kind: "learningGrades", course });
  const emptyTotal = (g: Grade) =>
    /^(加权总计|总计)$/.test(g.title) &&
    ["", "-", "—"].includes(g.score.trim()) &&
    !g.activity &&
    !g.status &&
    !g.updated;
  return (
    <Resource
      title="教学网成绩"
      q={q}
      service="course"
      login={login}
      heading={
        <span className="subtle">过程成绩 · 正式成绩请在“成绩”核对</span>
      }
    >
      {(data) => (
        <>
          {data.some((g) => !emptyTotal(g)) ? (
            <div className="table-scroll">
              <table className="data-table learning-grades">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>成绩</th>
                    <th>状态</th>
                    <th>最近更新</th>
                  </tr>
                </thead>
                <tbody>
                  {data
                    .filter((g) => !emptyTotal(g))
                    .map((g) => (
                      <tr key={g.id}>
                        <td>
                          <strong>{g.title}</strong>
                          <small>{g.category}</small>
                        </td>
                        <td>{g.score || "—"}</td>
                        <td>{g.activity || g.status || "—"}</td>
                        <td>{g.updated || "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>教师尚未发布成绩项目</Empty>
          )}
          {data.some(emptyTotal) && (
            <p className="footnote">课程总计尚未发布</p>
          )}
        </>
      )}
    </Resource>
  );
}
