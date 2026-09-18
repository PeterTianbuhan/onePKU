import SubtitleSettings from "../components/SubtitleSettings";
import WriteOperations from "../components/WriteOperations";
import ProfileForm from "../components/ProfileForm";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleHelp } from "lucide-react";
import { Button, type Login } from "../components/ui";
import {
  openOfficial,
  serviceNames,
  type Service,
  useResource,
  action,
  fmtTime,
} from "../lib/api";
import {
  emptyProfile,
  normalizeProfile,
  saveProfile,
  useProfile,
  type Profile,
} from "../lib/profile";
import { planIndex } from "../lib/curriculum";
export type Session = {
  service: Service;
  state: string;
  generation: string;
  verifiedAt?: string;
  message?: string;
};
export default function Settings({
  sessions,
  login,
}: {
  sessions?: Session[];
  login: Login;
}) {
  const client = useQueryClient();
  const [cacheMessage, setCacheMessage] = useState("");
  const prefs = useResource<{ keepAlive: boolean }>({ kind: "preferences" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const profileQuery = useProfile();
  const savedProfile = normalizeProfile(profileQuery.data?.data ?? null);
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [profileMessage, setProfileMessage] = useState("");
  useEffect(() => {
    if (profileQuery.data !== undefined && profileDraft === null)
      setProfileDraft(savedProfile ?? { ...emptyProfile });
    // 只在首次读到资料时初始化草稿，之后由用户编辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileQuery.data]);
  const overrideCount = Object.keys(savedProfile?.overrides ?? {}).length;
  async function persistProfile(next: Profile) {
    setProfileMessage("");
    try {
      await saveProfile(next);
      await profileQuery.refetch();
      setProfileDraft(next);
      setProfileMessage("资料已保存");
    } catch {
      setProfileMessage("资料未能保存，请重试");
    }
  }
  async function setKeepAlive(enabled: boolean) {
    setSaving(true);
    setError("");
    try {
      await action({ kind: "setKeepAlive", enabled });
      await prefs.refetch();
    } catch {
      setError("设置未能保存，请重试");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>设置</h1>
        </div>
        <span className="version">0.6.0</span>
      </header>
      <section className="resource settings-section account-settings">
        <h2>账号与登录</h2>
        <div className="connections">
          {(["course", "treehole", "campuscard"] as Service[]).map((s) => {
            const session = sessions?.find((x) => x.service === s);
            const state = session?.state;
            return (
              <div className="connection" key={s}>
                <div className={`service-symbol ${s}`}>
                  {serviceNames[s].slice(0, 1)}
                </div>
                <div className="grow">
                  <h3>{serviceNames[s]}</h3>
                  <p>
                    {s === "course"
                      ? "课程、作业、通知与资料"
                      : s === "treehole"
                        ? "成绩查询"
                        : "余额与收支明细"}
                  </p>
                  {session?.message && (
                    <p className="connection-message">{session.message}</p>
                  )}
                </div>
                <span
                  title={
                    session?.verifiedAt
                      ? `最近验证 ${fmtTime(session.verifiedAt)}`
                      : undefined
                  }
                  className={`connection-state ${["saved", "verified"].includes(state ?? "") ? "saved" : ""}`}
                >
                  {state === "verified"
                    ? "已连接"
                    : state === "saved"
                      ? "会话已保存"
                      : state === "expired"
                        ? "会话已过期"
                        : state === "error"
                          ? "读取失败"
                          : state
                            ? "尚未连接"
                            : "读取中"}
                </span>
                <Button
                  variant={
                    ["saved", "verified"].includes(state ?? "")
                      ? "quiet"
                      : "primary"
                  }
                  onClick={() => login(s)}
                >
                  {["saved", "verified"].includes(state ?? "")
                    ? "重新登录"
                    : "连接"}
                </Button>
              </div>
            );
          })}
        </div>
        <div className="keepalive-row">
          <div className="setting-label">
            <span>保持登录</span>
            <details
              className="inline-help"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  e.currentTarget.open = false;
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.currentTarget.open = false;
                  e.currentTarget.querySelector("summary")?.focus();
                }
              }}
            >
              <summary aria-label="保持登录说明">
                <CircleHelp size={16} />
              </summary>
              <p>
                应用运行时定期维护已保存的会话。退出后仍保留凭证；学校要求验证或令牌到期时，需要重新登录。
              </p>
            </details>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.data?.data?.keepAlive ?? false}
            aria-label="保持登录"
            className="keepalive-switch"
            disabled={saving || !prefs.data?.data}
            onClick={() => void setKeepAlive(!prefs.data?.data?.keepAlive)}
          >
            <span />
          </button>
        </div>
        {(error || prefs.error || prefs.data?.error) && (
          <p role="alert">{error || "设置暂时无法读取"}</p>
        )}
      </section>
      <section className="resource settings-section" aria-label="年级与专业">
        <h2>年级与专业</h2>
        <p className="section-description">
          用于培养方案页计算学分完成情况。只保存在本机，不发送给学校或任何服务器。
        </p>
        {profileDraft ? (
          <>
            <ProfileForm value={profileDraft} onChange={setProfileDraft} />
            <div className="submission-actions">
              <Button
                variant="primary"
                disabled={
                  JSON.stringify({ ...profileDraft, updatedAt: "" }) ===
                  JSON.stringify({
                    ...(savedProfile ?? emptyProfile),
                    updatedAt: "",
                  })
                }
                onClick={() => void persistProfile(profileDraft)}
              >
                保存资料
              </Button>
              {savedProfile?.planId && (
                <span className="subtle">
                  当前：
                  {planIndex.find((p) => p.id === savedProfile.planId)?.title ??
                    savedProfile.planId}
                </span>
              )}
              {overrideCount > 0 && (
                <Button
                  variant="quiet"
                  onClick={() =>
                    savedProfile &&
                    void persistProfile({ ...savedProfile, overrides: {} })
                  }
                >
                  清除 {overrideCount} 条手动归类
                </Button>
              )}
            </div>
            {profileMessage && <p role="status">{profileMessage}</p>}
          </>
        ) : (
          <div className="skeleton" aria-label="正在读取资料">
            <i />
          </div>
        )}
      </section>
      <SubtitleSettings />
      <section className="resource settings-section">
        <h2>数据与存储</h2>
        <div className="settings-facts">
          <div>
            <span>资料保存位置</span>
            <strong>下载 / OnePKU</strong>
          </div>
        </div>
        <div className="storage-actions">
          <details className="settings-explanation">
            <summary>数据保存与更新说明</summary>
            <p>
              数据与账号凭证保存在本机，凭证与 PKU CLI 共用。通知和作业每 5
              分钟更新；网络不可用时保留上次数据并提示更新时间。校园日期统一使用北京时间。
            </p>
            <p>
              清除页面缓存会重新获取页面数据，保留账号连接、阅读记录和已下载文件。
            </p>
          </details>
          <Button
            variant="quiet"
            onClick={() => {
              void action({ kind: "clearCache" })
                .then(async () => {
                  await client.resetQueries({ queryKey: ["resource"] });
                  setCacheMessage("本地缓存已清除，页面会重新获取数据");
                })
                .catch(() => setCacheMessage("缓存未能清除，请重试"));
            }}
          >
            清除页面缓存
          </Button>
        </div>
        {cacheMessage && <p role="status">{cacheMessage}</p>}
        <WriteOperations />
      </section>
      <section className="resource settings-section">
        <h2>关于与原站入口</h2>
        <p className="section-description">
          OnePKU · 基于 PKU CLI 的校园桌面工具，非学校官方客户端。
        </p>
        <div className="submission-actions">
          <Button onClick={() => void openOfficial("treehole")}>树洞</Button>
          <Button onClick={() => void openOfficial("elective")}>选退课</Button>
          <Button onClick={() => void openOfficial("portal")}>校内门户</Button>
        </div>
      </section>
    </>
  );
}
