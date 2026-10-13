import SubtitleSettings from "../components/SubtitleSettings";
import WriteOperations from "../components/WriteOperations";
import UpdateSettings from "../components/UpdateSettings";
import ProfileForm from "../components/ProfileForm";
import SettingRow from "../components/SettingRow";
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, type Login } from "../components/ui";
import {
  openOfficial,
  resetService,
  serviceNames,
  type Service,
  useResource,
  action,
  fmtTime,
  chooseDownloadFolder,
  chooseCacheFolder,
  connectHaoxue,
  type Haoxue,
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
import { chooseTheme, savedTheme, type ThemeMode } from "../lib/theme";
import { APP_VERSION, RELEASES_URL } from "../lib/updater";

export type Session = {
  service: Service;
  state: string;
  generation: string;
  verifiedAt?: string;
  message?: string;
};

// 每个服务现在只负责哪一块，写在卡片第二行。
const serviceScope: Record<Service, string> = {
  course: "课程、作业、通知与资料",
  treehole: "成绩",
  campuscard: "余额与收支",
  bdkj: "场地预约",
  portal: "识别本院",
};
const REPO_URL = "https://github.com/PeterTianbuhan/onePKU";
type DepartmentState = {
  selected: string;
  detected: string;
  effective: string;
  source: string;
  options: string[];
};
type PortalDepartment = {
  connected: boolean;
  name: string;
  department: string;
};

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

// 一张服务连接卡片：标识、用途、状态与「连接/重新登录」「断开」。
function ServiceCard({
  service,
  name,
  scope,
  state,
  connected,
  message,
  verifiedAt,
  onConnect,
  onDisconnect,
  extra,
}: {
  service: string;
  name: string;
  scope: string;
  state: string;
  connected: boolean;
  message?: string;
  verifiedAt?: string;
  onConnect: () => void;
  onDisconnect?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="connection">
      <div className={`service-symbol ${service}`}>{name.slice(0, 1)}</div>
      <div className="grow">
        <h3>{name}</h3>
        <p>{scope}</p>
        {message && <p className="connection-message">{message}</p>}
      </div>
      <span
        title={verifiedAt ? `最近验证 ${fmtTime(verifiedAt)}` : undefined}
        className={`connection-state ${connected ? "saved" : ""}`}
      >
        {state}
      </span>
      {extra}
      <Button variant={connected ? "" : "primary"} onClick={onConnect}>
        {connected ? "重新登录" : "连接"}
      </Button>
      {connected && onDisconnect && (
        <Button
          title="只断开这个服务，本机缓存与偏好保留"
          onClick={onDisconnect}
        >
          断开
        </Button>
      )}
    </div>
  );
}

export default function Settings({
  sessions,
  login,
}: {
  sessions?: Session[];
  login: Login;
}) {
  const inApp = "__TAURI_INTERNALS__" in window;
  const client = useQueryClient();
  const prefs = useResource<Preferences>({ kind: "preferences" });
  const haoxue = useResource<Haoxue>({ kind: "haoxueStatus" });
  const credentials = useResource<{ stored: boolean; username: string }>({
    kind: "credentials",
  });
  const college = useResource<DepartmentState>({ kind: "departments" });
  const portal = useResource<PortalDepartment>({ kind: "portalStatus" });
  const [keepAliveBusy, setKeepAliveBusy] = useState(false);
  const [keepAliveError, setKeepAliveError] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [cacheRootMessage, setCacheRootMessage] = useState("");
  const [cacheRootError, setCacheRootError] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(savedTheme);
  const [cacheMessage, setCacheMessage] = useState("");
  const [cacheError, setCacheError] = useState("");
  const [haoxueError, setHaoxueError] = useState("");
  const [credentialMessage, setCredentialMessage] = useState("");
  const [credentialError, setCredentialError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [portalMessage, setPortalMessage] = useState("");
  const [portalError, setPortalError] = useState("");
  const [collegeDraft, setCollegeDraft] = useState<string>();
  const [collegeMessage, setCollegeMessage] = useState("");
  const [collegeError, setCollegeError] = useState("");
  useEffect(() => {
    const loaded = college.data?.data?.selected;
    if (collegeDraft === undefined && loaded !== undefined)
      setCollegeDraft(loaded);
  }, [college.data, collegeDraft]);
  function persistDepartment(value: string) {
    setCollegeError("");
    void action<DepartmentState>({ kind: "setDepartment", value })
      .then(() =>
        setCollegeMessage(value ? `本院已设为 ${value}` : "已取消选择本院"),
      )
      .catch(() => setCollegeError("未能保存院系，请重试"))
      .finally(() => void college.refetch());
  }
  function refreshSessions() {
    void client.invalidateQueries({
      queryKey: ["resource", { kind: "sessions" }],
    });
  }
  function disconnectService(service: Service) {
    void action({ kind: "serviceLogout", service })
      .then(() => {
        resetService(client, service);
        refreshSessions();
      })
      .catch(() => {});
  }
  const learner = haoxue.data?.data;
  const portalConnected = portal.data?.data?.connected ?? false;
  const portalDepartment = portal.data?.data?.department ?? "";

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
  function detectDepartment() {
    setDetecting(true);
    setPortalError("");
    void action<PortalDepartment>({ kind: "portalDetect" })
      .then((value) => {
        setPortalMessage(`识别到本院：${value.department}`);
        void portal.refetch();
        void college.refetch();
        void client.invalidateQueries({ queryKey: ["resource"] });
      })
      .catch((error: Error) => setPortalError(error.message || "门户识别失败"))
      .finally(() => setDetecting(false));
  }

  const root = prefs.data?.data;
  const rootText = root?.downloadRoot
    ? root.downloadRoot.replace(/^\/Users\/[^/]+/, "~")
    : "~/Downloads/OnePKU";
  const rootIsDefault = root ? root.downloadRootIsDefault !== false : true;
  const cacheText = root?.cacheRoot
    ? root.cacheRoot.replace(/^\/Users\/[^/]+/, "~")
    : "应用缓存目录";
  const cacheIsDefault = root ? root.cacheRootIsDefault !== false : true;
  // 统一身份认证的服务按安卓端顺序排，课堂实测与校内门户各自跟在后面。
  // 北大空间只在场地预约页按需登录，不占一张连接卡片。
  const cards = (["course", "treehole", "campuscard"] as Service[]).map(
    (service) => {
      const session = sessions?.find((x) => x.service === service);
      const connected = ["saved", "verified"].includes(session?.state ?? "");
      return (
        <ServiceCard
          key={service}
          service={service}
          name={serviceNames[service]}
          scope={serviceScope[service]}
          state={stateText(session?.state)}
          connected={connected}
          message={session?.message}
          verifiedAt={session?.verifiedAt}
          onConnect={() => login(service)}
          onDisconnect={
            connected ? () => disconnectService(service) : undefined
          }
        />
      );
    },
  );

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>设置</h1>
        </div>
        <span className="version">v{APP_VERSION}</span>
      </header>

      <section className="resource settings-section" aria-label="服务连接">
        <h2>服务连接</h2>
        <div className="connections">
          {cards}
          <ServiceCard
            service="portal"
            name={serviceNames.portal}
            scope={serviceScope.portal}
            state={portalConnected ? "已连接" : "尚未连接"}
            connected={portalConnected}
            message={
              portalError ||
              portalMessage ||
              (portalConnected && portalDepartment
                ? `单位：${portalDepartment}`
                : undefined)
            }
            onConnect={() => login("portal")}
            onDisconnect={
              portalConnected
                ? () =>
                    void action({ kind: "portalLogout" })
                      .then(() => portal.refetch())
                      .catch(() => setPortalError("未能断开，请重试"))
                : undefined
            }
            extra={
              portalConnected ? (
                <Button disabled={detecting} onClick={detectDepartment}>
                  识别学院
                </Button>
              ) : undefined
            }
          />
          <ServiceCard
            service="haoxue"
            name="课堂实录"
            scope="课程回放与课次"
            state={
              learner?.connected
                ? "已连接"
                : haoxue.data?.error
                  ? "读取失败"
                  : "尚未连接"
            }
            connected={learner?.connected ?? false}
            message={
              haoxueError ||
              (learner?.connected
                ? `${learner.name || "已连接"} · ${learner.account}`
                : inApp
                  ? undefined
                  : "请在桌面应用中连接课堂实录")
            }
            onConnect={() => {
              setHaoxueError("");
              void connectHaoxue().catch(() =>
                setHaoxueError("登录窗口未能打开，请重试"),
              );
            }}
            onDisconnect={
              learner?.connected
                ? () => {
                    setHaoxueError("");
                    void action({ kind: "haoxueLogout" })
                      .then(() => haoxue.refetch())
                      .catch(() => setHaoxueError("未能退出，请重试"));
                  }
                : undefined
            }
          />
        </div>
        <p className="footnote">
          登录都在学校页面完成，应用只保存学校交回的会话；课堂实录走学校统一身份认证，不经手密码。
        </p>
        <SettingRow
          label="本院通知"
          description="已适配的学院读学院官网通知页，读不到时回退门户部门通知。留空就用校内门户识别到的单位。"
          stacked
          control={
            <Button
              variant="primary"
              disabled={
                collegeDraft === undefined ||
                collegeDraft === (college.data?.data?.selected ?? "")
              }
              onClick={() =>
                collegeDraft !== undefined && persistDepartment(collegeDraft)
              }
            >
              保存
            </Button>
          }
          status={
            college.data?.data?.effective
              ? `当前：${college.data.data.effective}（${college.data.data.source || "未识别"}）`
              : collegeMessage || undefined
          }
          error={collegeError || undefined}
        >
          {collegeDraft === undefined ? (
            <div className="skeleton" aria-label="正在读取院系列表">
              <i />
            </div>
          ) : (
            <select
              aria-label="本院（院系）"
              value={collegeDraft}
              onChange={(e) => setCollegeDraft(e.target.value)}
            >
              <option value="">未选择</option>
              {(college.data?.data?.options ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </SettingRow>
      </section>

      <section className="resource settings-section" aria-label="登录与凭证">
        <h2>登录与凭证</h2>
        <SettingRow
          label="统一身份认证"
          description="账号密码可以记在系统加密存储里（macOS 钥匙串 / Windows 凭据管理器），会话过期时应用用它静默重连；作业提交等写操作绝不自动重放。"
          control={
            <Button
              onClick={() => {
                setCredentialError("");
                void action({ kind: "clearCredentials" })
                  .then(() => {
                    setCredentialMessage("已清除记住的账号");
                    void credentials.refetch();
                  })
                  .catch(() => setCredentialError("未能清除，请重试"));
              }}
              disabled={!credentials.data?.data?.stored}
            >
              清除
            </Button>
          }
          status={
            credentials.data?.data?.stored
              ? `已记住 ${credentials.data.data.username}`
              : credentialMessage || undefined
          }
          error={credentialError || undefined}
        />
        <SettingRow
          label="保持登录"
          description="运行时每 15 分钟做一次轻量会话检查；学校要求验证或令牌到期时仍需重新登录。"
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
              <Button
                onClick={() => {
                  setStorageError("");
                  void action({ kind: "openDownloadRoot" }).catch(
                    (e: unknown) =>
                      setStorageError(
                        "未能打开保存位置：" +
                          (e instanceof Error ? e.message : String(e)),
                      ),
                  );
                }}
              >
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
          label="回放缓存位置"
          description={
            <>
              <span className="path-value">{cacheText}</span>
              {cacheIsDefault ? "（默认）" : ""}
              。缓存播放的分片存在这里，退出播放就清掉；「下载
              MP4」的成片仍存在上面的保存位置。
            </>
          }
          control={
            <>
              {!cacheIsDefault && (
                <button
                  className="text-button"
                  onClick={() => {
                    setCacheRootMessage("");
                    setCacheRootError("");
                    void action({ kind: "resetCacheRoot" })
                      .then(async () => {
                        await prefs.refetch();
                        setCacheRootMessage("已恢复为默认位置。");
                      })
                      .catch(() =>
                        setCacheRootError("未能恢复默认位置，请重试"),
                      );
                  }}
                >
                  恢复默认
                </button>
              )}
              <Button
                onClick={() => {
                  setCacheRootError("");
                  void action({ kind: "openCacheRoot" }).catch((e: unknown) =>
                    setCacheRootError(
                      "未能打开缓存位置：" +
                        (e instanceof Error ? e.message : String(e)),
                    ),
                  );
                }}
              >
                打开
              </Button>
              {inApp && (
                <Button
                  onClick={() => {
                    setCacheRootMessage("");
                    setCacheRootError("");
                    void chooseCacheFolder()
                      .then(async (next) => {
                        if (!next) return;
                        await prefs.refetch();
                        setCacheRootMessage(
                          "之后的回放缓存存在这里；原位置的缓存已清掉。",
                        );
                      })
                      .catch((e: Error) =>
                        setCacheRootError(`未能更改缓存位置：${e.message}`),
                      );
                  }}
                >
                  更改…
                </Button>
              )}
            </>
          }
          status={cacheRootMessage || undefined}
          error={cacheRootError || undefined}
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
        <SettingRow
          label="外观"
          description="深色与浅色用的是同一套语义色；「跟随系统」会跟着系统的浅色/深色设置即时变化。"
          control={
            <div className="theme-choice" role="group" aria-label="外观模式">
              {(
                [
                  ["system", "跟随系统"],
                  ["light", "浅色"],
                  ["dark", "深色"],
                ] as [ThemeMode, string][]
              ).map(([mode, name]) => (
                <button
                  key={mode}
                  type="button"
                  className={theme === mode ? "active" : ""}
                  aria-pressed={theme === mode}
                  onClick={() => {
                    setTheme(mode);
                    chooseTheme(mode);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          }
        />
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
