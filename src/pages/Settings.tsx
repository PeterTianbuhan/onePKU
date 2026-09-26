import SubtitleSettings from "../components/SubtitleSettings";
import WriteOperations from "../components/WriteOperations";
import UpdateSettings from "../components/UpdateSettings";
import ProfileForm from "../components/ProfileForm";
import SettingRow from "../components/SettingRow";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, type Login } from "../components/ui";
import {
  openOfficial,
  serviceNames,
  type Service,
  useResource,
  action,
  fmtTime,
  chooseDownloadFolder,
  forgetPasswords,
  type Preferences,
} from "../lib/api";
import {
  emptyProfile,
  normalizeProfile,
  saveProfile,
  useProfile,
  type Profile,
} from "../lib/profile";
import { planIndex } from "../lib/curriculum";
import { APP_VERSION, RELEASES_URL } from "../lib/updater";

export type Session = {
  service: Service;
  state: string;
  generation: string;
  verifiedAt?: string;
  message?: string;
};

const serviceScope: Record<Service, string> = {
  course: "课程、作业、通知与资料",
  treehole: "成绩",
  campuscard: "余额与收支",
  bdkj: "场地预约",
};
const REPO_URL = "https://github.com/PeterTianbuhan/onePKU";

function stateText(state?: string) {
  switch (state) {
    case "verified":
      return "已连接";
    case "saved":
      return "会话已保存";
    case "expired":
      return "会话已过期";
    case "error":
      return "读取失败";
    case undefined:
      return "读取中";
    default:
      return "尚未连接";
  }
}

export default function Settings({
  sessions,
  login,
}: {
  sessions?: Session[];
  login: Login;
}) {
  const client = useQueryClient();
  const inApp = "__TAURI_INTERNALS__" in window;
  const prefs = useResource<Preferences>({ kind: "preferences" });
  const [keepAliveBusy, setKeepAliveBusy] = useState(false);
  const [keepAliveError, setKeepAliveError] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [cacheMessage, setCacheMessage] = useState("");
  const [cacheError, setCacheError] = useState("");

  const profileQuery = useProfile();
  const savedProfile = normalizeProfile(profileQuery.data?.data ?? null);
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [profileMessage, setProfileMessage] = useState("");
  const [profileError, setProfileError] = useState("");
  useEffect(() => {
    if (profileQuery.data !== undefined && profileDraft === null)
      setProfileDraft(savedProfile ?? { ...emptyProfile });
    // 只在首次读到资料时初始化草稿，之后由用户编辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileQuery.data]);
  const overrideCount = Object.keys(savedProfile?.overrides ?? {}).length;
  const profileDirty =
    profileDraft !== null &&
    JSON.stringify({ ...profileDraft, updatedAt: "" }) !==
      JSON.stringify({ ...(savedProfile ?? emptyProfile), updatedAt: "" });
  const currentPlan = savedProfile?.planId
    ? (planIndex.find((p) => p.id === savedProfile.planId)?.title ??
      savedProfile.planId)
    : null;

  async function persistProfile(next: Profile) {
    setProfileMessage("");
    setProfileError("");
    try {
      await saveProfile(next);
      await profileQuery.refetch();
      setProfileDraft(next);
      setProfileMessage("已保存");
    } catch {
      setProfileError("资料未能保存，请重试");
    }
  }
  async function setKeepAlive(enabled: boolean) {
    setKeepAliveBusy(true);
    setKeepAliveError("");
    try {
      await action({ kind: "setKeepAlive", enabled });
      await prefs.refetch();
    } catch {
      setKeepAliveError("设置未能保存，请重试");
    } finally {
      setKeepAliveBusy(false);
    }
  }

  const root = prefs.data?.data;
  const rootText = root?.downloadRoot
    ? root.downloadRoot.replace(/^\/Users\/[^/]+/, "~")
    : "~/Downloads/OnePKU";
  const rootIsDefault = root ? root.downloadRootIsDefault !== false : true;

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>设置</h1>
        </div>
        <span className="version">v{APP_VERSION}</span>
      </header>

      <section className="resource settings-section" aria-label="账号">
        <div className="settings-account-heading">
          <h2>账号</h2>
          <Button variant="primary" onClick={() => login("all")}>
            统一登录
          </Button>
        </div>
        <div className="connections">
          {(["course", "treehole", "campuscard"] as Service[]).map((s) => {
            const session = sessions?.find((x) => x.service === s);
            const connected = ["saved", "verified"].includes(
              session?.state ?? "",
            );
            return (
              <div className="connection" key={s}>
                <div className={`service-symbol ${s}`}>
                  {serviceNames[s].slice(0, 1)}
                </div>
                <div className="grow">
                  <h3>{serviceNames[s]}</h3>
                  <p>{serviceScope[s]}</p>
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
                  className={`connection-state ${connected ? "saved" : ""}`}
                >
                  {stateText(session?.state)}
                </span>
                <Button
                  variant={connected ? "" : "primary"}
                  onClick={() => login(s)}
                >
                  {connected ? "重新登录" : "连接"}
                </Button>
              </div>
            );
          })}
        </div>
        <SettingRow
          label="保持登录"
          description="定期检查会话；已记住密码时，会话失效可自动重登。短信和动态口令仍需手动验证。"
          control={
            <button
              type="button"
              role="switch"
              aria-checked={root?.keepAlive ?? false}
              aria-label="保持登录"
              className="keepalive-switch"
              disabled={keepAliveBusy || !root}
              onClick={() => void setKeepAlive(!root?.keepAlive)}
            >
              <span />
            </button>
          }
          error={
            keepAliveError ||
            (prefs.error || prefs.data?.error ? "设置暂时无法读取" : undefined)
          }
        />
        {inApp && (
          <SettingRow
            label="已保存的密码"
            description="删除系统钥匙串中 OnePKU 保存的密码，当前已连接的会话继续可用。"
            control={
              <Button
                disabled={passwordBusy}
                onClick={async () => {
                  setPasswordBusy(true);
                  setPasswordMessage("");
                  try {
                    await forgetPasswords();
                    setPasswordMessage("已删除保存的密码");
                  } catch (e) {
                    setPasswordMessage(
                      e instanceof Error ? e.message : String(e),
                    );
                  } finally {
                    setPasswordBusy(false);
                  }
                }}
              >
                {passwordBusy ? "正在删除…" : "忘记密码"}
              </Button>
            }
          />
        )}
        {passwordMessage && (
          <p className="subtle" role="status">
            {passwordMessage}
          </p>
        )}
      </section>

      <section className="resource settings-section" aria-label="年级与专业">
        <h2>年级与专业</h2>
        <SettingRow
          label="培养方案"
          description={
            currentPlan
              ? `当前：${currentPlan}。只保存在本机，用于计算学分完成情况。`
              : "用于培养方案页计算学分完成情况。只保存在本机。"
          }
          stacked
          control={
            <Button
              variant="primary"
              disabled={!profileDirty || !profileDraft}
              onClick={() => profileDraft && void persistProfile(profileDraft)}
            >
              保存
            </Button>
          }
          status={profileMessage || undefined}
          error={profileError || undefined}
        >
          {profileDraft ? (
            <ProfileForm value={profileDraft} onChange={setProfileDraft} />
          ) : (
            <div className="skeleton" aria-label="正在读取资料">
              <i />
            </div>
          )}
        </SettingRow>
        {overrideCount > 0 && (
          <SettingRow
            label="手动归类"
            description={`培养方案页里手动归入学分系列的 ${overrideCount} 门课。`}
            control={
              <Button
                onClick={() =>
                  savedProfile &&
                  void persistProfile({ ...savedProfile, overrides: {} })
                }
              >
                全部清除
              </Button>
            }
          />
        )}
      </section>

      <section className="resource settings-section" aria-label="本机数据">
        <h2>本机数据</h2>
        <SettingRow
          label="保存位置"
          description={
            <>
              <span className="path-value">{rootText}</span>
              {rootIsDefault ? "（默认）" : ""}
              。课件、回放与培养方案原文按学期和课程整理。
            </>
          }
          control={
            <>
              {!rootIsDefault && (
                <button
                  className="text-button"
                  onClick={() => {
                    setStorageMessage("");
                    setStorageError("");
                    void action({ kind: "resetDownloadRoot" })
                      .then(async () => {
                        await prefs.refetch();
                        setStorageMessage("已恢复为默认位置。");
                      })
                      .catch(() => setStorageError("未能恢复默认位置，请重试"));
                  }}
                >
                  恢复默认
                </button>
              )}
              <Button onClick={() => void action({ kind: "openDownloadRoot" })}>
                打开
              </Button>
              {inApp && (
                <Button
                  onClick={() => {
                    setStorageMessage("");
                    setStorageError("");
                    void chooseDownloadFolder()
                      .then(async (next) => {
                        if (!next) return;
                        await prefs.refetch();
                        setStorageMessage(
                          "之后的下载会保存到这里；已下载的文件留在原位置。",
                        );
                      })
                      .catch((e: Error) =>
                        setStorageError(`未能更改保存位置：${e.message}`),
                      );
                  }}
                >
                  更改…
                </Button>
              )}
            </>
          }
          status={storageMessage || undefined}
          error={storageError || undefined}
        />
        <SettingRow
          label="页面缓存"
          description="清除后页面会重新获取数据；账号连接、阅读记录和已下载文件保留。"
          control={
            <Button
              onClick={() => {
                setCacheMessage("");
                setCacheError("");
                void action({ kind: "clearCache" })
                  .then(async () => {
                    await client.resetQueries({ queryKey: ["resource"] });
                    setCacheMessage("已清除，页面会重新获取数据。");
                  })
                  .catch(() => setCacheError("缓存未能清除，请重试"));
              }}
            >
              清除
            </Button>
          }
          status={cacheMessage || undefined}
          error={cacheError || undefined}
        />
        <SubtitleSettings />
        <WriteOperations />
      </section>

      <section className="resource settings-section" aria-label="关于">
        <h2>关于</h2>
        <UpdateSettings />
        <SettingRow
          label="学校原站"
          description="需要发帖、选退课或办事时，直接去学校页面。OnePKU 不是学校官方客户端。"
          control={
            <>
              <Button onClick={() => void openOfficial("treehole")}>
                树洞
              </Button>
              <Button onClick={() => void openOfficial("elective")}>
                选退课
              </Button>
              <Button onClick={() => void openOfficial("portal")}>
                校内门户
              </Button>
            </>
          }
        />
        <SettingRow
          label="开源"
          description="MIT 许可。发现问题或想补培养方案数据，欢迎到仓库提 issue。"
          control={
            <>
              <button
                className="text-button"
                onClick={() =>
                  void action({ kind: "openLink", url: RELEASES_URL })
                }
              >
                更新记录
              </button>
              <Button
                onClick={() => void action({ kind: "openLink", url: REPO_URL })}
              >
                GitHub 仓库
              </Button>
            </>
          }
        />
      </section>
    </>
  );
}
