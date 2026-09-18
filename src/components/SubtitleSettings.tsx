import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { action, useResource } from "../lib/api";
import { usePageParams } from "../lib/navigation";

type Models = {
  model: string;
  models: { id: string; label: string; hint: string }[];
  available: boolean;
  custom: boolean;
  nativeInstallSupported?: boolean;
  setupMessage?: string | null;
};
export default function SubtitleSettings() {
  const request = { kind: "subtitleSettings" };
  const resource = useResource<Models>(request);
  const data = resource.data?.data;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [params] = usePageParams("设置");
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (params.get("section") === "subtitles") {
      section.current?.scrollIntoView({ block: "start" });
      section.current?.focus({ preventScroll: true });
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
  return (
    <section
      ref={section}
      className="resource settings-section"
      aria-label="字幕设置"
      tabIndex={-1}
    >
      <h2>字幕</h2>
      {data?.available && (
        <div className="subtitle-model-row">
          <div>
            <label htmlFor="subtitle-model">识别模型</label>
            <p className="subtle">本机识别，音频不上传。</p>
          </div>
          <select
            id="subtitle-model"
            value={data?.model ?? ""}
            disabled={busy || !data}
            onChange={(e) => void choose(e.target.value)}
          >
            {!data && <option value="">正在读取…</option>}
            {data?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label.replace(" · 本机", "")}
              </option>
            ))}
          </select>
        </div>
      )}
      {data?.available && (
        <p className="footnote">
          {selected?.hint}
          {selected ? " · " : ""}仅显示本机
          已安装的模型，更改用于之后启动的任务。
        </p>
      )}
      {data && !data.available && (
        <p className="footnote">
          {data.setupMessage ||
            "本机字幕组件尚未安装，仍可在播放器导入字幕文件。"}
        </p>
      )}
      {data?.nativeInstallSupported !== false ? (
        <details>
          <summary>
            {data?.available ? "安装与检查" : "按需安装本机字幕"}
          </summary>
          <p className="footnote">
            Apple Silicon Mac · macOS 14 或以上。安装 Belle
            中文模型与独立运行环境，模型约 864
            MB，另需依赖空间。仅安装时联网，识别时音频不上传。
          </p>
          <p className="footnote">
            下载 OnePKU 源码后，在项目目录的终端运行。需要先安装 uv 和
            ffmpeg（Homebrew：<code>brew install uv ffmpeg</code>）。
          </p>
          <pre>
            <code>bash scripts/subtitles/install.sh</code>
          </pre>
          <p className="footnote">
            安装工具会复用可用配置，检查通过后再启用。排查问题可在命令末尾添加{" "}
            <code>--check</code>；修复已有配置可添加 <code>--replace</code>
            ，旧环境与配置备份保留。
          </p>
          <button
            className="button quiet"
            disabled={resource.isFetching}
            onClick={() => void resource.refetch()}
          >
            {resource.isFetching ? "正在刷新…" : "安装后刷新"}
          </button>
        </details>
      ) : (
        <p className="footnote">
          此平台暂不提供内置自动字幕安装。可在播放器导入 SRT /
          VTT；已有字幕继续保留。 高级用户可按源码 docs/SUBTITLES.md
          配置本机识别适配器，音频不上传。
        </p>
      )}
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      {(error || resource.error || resource.data?.error) && (
        <p className="subtitle-error" role="alert">
          {error || "字幕设置暂时无法读取"}
        </p>
      )}
    </section>
  );
}
