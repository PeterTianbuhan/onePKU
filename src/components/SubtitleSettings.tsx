import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { action, useResource } from "../lib/api";
import { usePageParams } from "../lib/navigation";
import SettingRow from "./SettingRow";

type Models = {
  model: string;
  models: { id: string; label: string; hint: string }[];
  available: boolean;
  custom: boolean;
  nativeInstallSupported?: boolean;
  setupMessage?: string | null;
};
/** 字幕识别模型一行，以及按需安装说明。作为“本机数据”里的两行渲染。 */
export default function SubtitleSettings() {
  const request = { kind: "subtitleSettings" };
  const resource = useResource<Models>(request);
  const data = resource.data?.data;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [params] = usePageParams("设置");
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (params.get("section") === "subtitles") {
      anchor.current?.scrollIntoView({ block: "start" });
      anchor.current?.focus({ preventScroll: true });
    }
  }, [params]);
  async function choose(model: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await action<Models>({ kind: "setSubtitleModel", model });
      client.setQueryData(["resource", request], {
        ...resource.data,
        data: next,
      });
      setMessage("已保存。已有字幕保留；未完成的字幕使用新模型时会从头生成。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "模型设置未能保存");
    } finally {
      setBusy(false);
    }
  }
  const selected = data?.models.find((model) => model.id === data.model);
  const readError = error || resource.error || resource.data?.error;
  return (
    <div ref={anchor} tabIndex={-1} className="setting-anchor">
      <SettingRow
        label="字幕识别模型"
        description={
          !data
            ? "正在读取字幕设置…"
            : data.available
              ? `本机识别，音频不上传。${selected?.hint ?? ""}`
              : (data.setupMessage ??
                "本机字幕组件尚未安装，仍可在播放器导入字幕文件。")
        }
        control={
          data?.available ? (
            <select
              aria-label="识别模型"
              value={data.model}
              disabled={busy}
              onChange={(e) => void choose(e.target.value)}
            >
              {data.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label.replace(" · 本机", "")}
                </option>
              ))}
            </select>
          ) : undefined
        }
        status={message || undefined}
        error={readError ? error || "字幕设置暂时无法读取" : undefined}
      />
      {data?.nativeInstallSupported !== false ? (
        <details className="setting-row setting-details">
          <summary>
            {data?.available ? "安装与检查" : "按需安装本机字幕"}
          </summary>
          <div className="setting-details-body">
            <p>
              Apple Silicon Mac、macOS 14 或以上。安装 Belle
              中文模型与独立运行环境，模型约 864
              MB。仅安装时联网，识别时音频不上传。
            </p>
            <p>
              需要先安装 uv 和 ffmpeg（<code>brew install uv ffmpeg</code>
              ），然后在 OnePKU 源码目录运行：
            </p>
            <pre>
              <code>bash scripts/subtitles/install.sh</code>
            </pre>
            <p>
              排查问题在命令末尾加 <code>--check</code>；修复已有配置加{" "}
              <code>--replace</code>，旧环境与配置备份保留。
            </p>
            <button
              className="button"
              disabled={resource.isFetching}
              onClick={() => void resource.refetch()}
            >
              {resource.isFetching ? "正在刷新…" : "安装后刷新"}
            </button>
          </div>
        </details>
      ) : (
        <SettingRow
          label="本机字幕"
          description="Windows 可在播放器导入 SRT / VTT 字幕，或配置自定义本地识别适配器；已有字幕继续保留。内置 MLX 安装仅支持 Apple Silicon Mac。"
        />
      )}
    </div>
  );
}
