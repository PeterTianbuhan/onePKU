import { useState } from "react";
import {
  APP_VERSION,
  checkForUpdate,
  inApp,
  relaunchApp,
  type UpdateHandle,
} from "../lib/updater";
import { isMacOS } from "../lib/platform";
import SettingRow from "./SettingRow";
import { Button } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest"; checkedAt: string }
  | { kind: "available"; update: UpdateHandle }
  | {
      kind: "downloading";
      update: UpdateHandle;
      done: number;
      total: number | null;
    }
  | { kind: "ready"; update: UpdateHandle }
  | { kind: "error"; message: string };

function mb(n: number) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 设置页“版本”一行：当前版本、检查、下载安装、重启。 */
export default function UpdateSettings() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  async function check() {
    setPhase({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      setPhase(
        update
          ? { kind: "available", update }
          : {
              kind: "latest",
              checkedAt: new Date().toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
      );
    } catch (e) {
      setPhase({
        kind: "error",
        message: `未能检查更新：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function install(update: UpdateHandle) {
    setPhase({ kind: "downloading", update, done: 0, total: null });
    try {
      await update.install((done, total) =>
        setPhase({ kind: "downloading", update, done, total }),
      );
      setPhase({ kind: "ready", update });
    } catch (e) {
      setPhase({
        kind: "error",
        message: `更新未能安装：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const control = !inApp() ? (
    <span className="subtle">浏览器预览不能更新</span>
  ) : phase.kind === "available" ? (
    <Button variant="primary" onClick={() => void install(phase.update)}>
      更新到 v{phase.update.version}
    </Button>
  ) : phase.kind === "ready" ? (
    <Button variant="primary" onClick={() => void relaunchApp()}>
      重新启动
    </Button>
  ) : phase.kind === "downloading" ? (
    <span className="subtle">
      {phase.total
        ? `下载中 ${mb(phase.done)} / ${mb(phase.total)}`
        : `下载中 ${mb(phase.done)}`}
    </span>
  ) : (
    <Button disabled={phase.kind === "checking"} onClick={() => void check()}>
      {phase.kind === "checking" ? "正在检查…" : "检查更新"}
    </Button>
  );

  const status =
    phase.kind === "latest"
      ? `已是最新版本（${phase.checkedAt} 检查）`
      : phase.kind === "available" && phase.update.notes
        ? phase.update.notes
        : phase.kind === "ready"
          ? "新版本已安装，重新启动后生效。"
          : undefined;

  return (
    <SettingRow
      label={`OnePKU v${APP_VERSION}`}
      description={
        isMacOS()
          ? "更新包来自 GitHub Releases，安装前校验签名。"
          : "更新包来自 GitHub Releases，安装前校验签名。Windows 安装更新时会退出应用并启动安装器，请先完成当前操作。"
      }
      control={control}
      status={status}
      error={phase.kind === "error" ? phase.message : undefined}
    />
  );
}
