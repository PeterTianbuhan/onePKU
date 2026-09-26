# 回放字幕

## 按需安装

字幕生成是可选组件。安装 OnePKU 不会自动下载模型；资料管理、回放播放与分片缓存、已有字幕显示和 SRT / VTT 导入都不需要识别环境。单独导出 MP4 仍需 ffmpeg。

第一版安装工具支持 Apple Silicon Mac（macOS 14 或以上）。下载 OnePKU 源码后，在项目根目录运行：

```sh
# 缺少工具时先安装；需要已有 Homebrew
brew install uv ffmpeg
bash scripts/subtitles/install.sh
```

安装工具用 uv 创建独立 Python 3.12 环境、按 `scripts/subtitles/requirements.lock` 安装固定版本依赖，并取得 Belle 中文 8-bit 模型的固定版本 `cb886304c3822efe538ac975446080fe370cb243`。模型约 864 MB，运行依赖另占空间；只在主动安装时联网，识别始终离线。模型使用 Hugging Face 缓存，已下载文件可复用。

配置写入前，会实际检查 ffmpeg、人声检测、模型加载和一次静音解码（仅检查运行链路，不是准确率测评）。全部通过才原子写入 `subtitles-provider.json`；失败不启用半成品。安装完成后在「设置 → 字幕 → 安装与检查」点击「安装后刷新」，或重新打开播放器。

已有配置默认只做离线检查并复用，不修改原环境。需要诊断或修复时：

```sh
bash scripts/subtitles/install.sh --check
bash scripts/subtitles/install.sh --replace
```

`--check` 不安装或改写配置；`--replace` 在 `Application Support/me.petertian.OnePKU/subtitle-runtimes/` 下创建新环境，检查通过后保留旧 JSON 备份并切换配置，旧环境和已生成字幕保留。生成任务运行时不能替换安装。失败后可重试并复用包与模型缓存；失败的独立环境目录可能保留，可在确认不被配置引用后手动移除。自定义适配器由使用者单独验证，工具不会默默替换它。不要把本机 JSON、环境、模型缓存或课程字幕提交到仓库。

安装步骤位于设置页折叠说明中；第一版不提供应用内自动安装器、模型下载管理或云端转写。

## 播放器

播放器的「添加字幕 / 字幕」默认显示字幕开关、一行进度和当前生成操作。导入 UTF-8 SRT / WebVTT、字幕延迟、字幕来源和重新生成位于「更多」。生成后自动装载；课程切换和重新打开应用后保留结果。原生视频字幕轨道支持普通播放和全屏。

生成按约一分钟的片段顺序进行：只下载当前片段需要的视频分片，提取音频并在本机识别，完成一段就保存并装载进播放器。识别期间可以观看已完成的部分。离开播放器后仍可继续，但应用必须保持运行；停止、退出或失败时保留已完成进度，重开后点击「继续生成」补齐剩余部分。重新生成已有字幕时，已完成的前半段使用新结果，剩余部分仍保留原字幕；整节完成后才替换完整文件。无声片段记录为已处理，避免继续时重复跑。拖动播放器暂不改变识别顺序。

字幕与视频缓存分开保存在 Application Support 下，按教学网稳定账号 ID、课程、回放分区，并绑定回放内容签名。同一账号重新登录、重启应用后自动复用，不需要重新导入或生成。启动时自动将当前登录会话下的旧字幕复制迁移到账号目录，保留原文件作为恢复副本。不同账号分别保存；账号 ID 来自教学网当前用户接口，不根据姓名或已保存的登录名猜测。账号查询暂时失败不阻断视频播放，下次打开时重试。清理视频缓存不删除字幕；后台生成期间不能清理同一回放或同时导入替换字幕。进程间文件锁避免多开应用重复占用识别资源。

## 模型设置

「设置 → 字幕」选择本机已安装的模型，目前支持 Belle 中文、Whisper Small 和 Whisper Tiny。只有配置与权重文件完整的模型才会列出；应用不自动下载模型。保存后用于之后启动的任务，已在运行的任务继续使用启动时的模型。已有字幕保留；切换模型后，未完成字幕会显示「重新生成」，避免将旧模型的断点误当成可继续。

播放器只保留当前回放的字幕操作；「更多 → 字幕模型设置」可直接到达此设置区。

## 识别适配层

`crates/campus-core/src/subtitles.rs` 管理任务、音频、取消、持久化和字幕格式；`scripts/subtitles/mlx_provider.py` 是识别适配器。播放器只接收 `{start, end, text}`，不依赖模型 SDK。

默认配置文件：`~/Library/Application Support/me.petertian.OnePKU/subtitles-provider.json`。它是本地开发配置，网页和教学网原文窗口无法传入程序路径或 shell 命令。

```json
{
  "label": "Belle Whisper 中文 · 本机",
  "engine": "mlx-audio",
  "python": "/absolute/path/to/subtitles-runtime/bin/python",
  "model": "/absolute/path/to/local/model/snapshot",
  "ffmpeg": "/opt/homebrew/bin/ffmpeg"
}
```

内置适配器支持 `mlx-audio` 和 `mlx-whisper`；当前本机使用已有的 `mlx-community/belle-whisper-large-v3-turbo-zh-8bit` 模型缓存，通过 MLX Audio 加载。没有配置文件时沿用 MLX Whisper Small 默认值。模型文件和 Python 环境独立于应用安装包，更新 app 不重装模型。

运行环境的直接依赖在 `scripts/subtitles/requirements.txt`，完整版本锁定在 `requirements.lock`。优先使用上述安装工具；高级用户也可指定自己的 Python 环境和模型快照。识别进程启用 `HF_HUB_OFFLINE=1`，不向云端发送课堂音频。

适配器先用 Silero VAD 检测人声，再按带边界上下文的片段识别，按词时间戳切成短字幕。低置信度或缺乏人声覆盖的片段被跳过；不会保证每个字正确。课程术语和嘈杂音频仍可能误识别。

替换整个识别引擎时，在配置中添加绝对路径 `adapter`。后端执行 `python adapter request.json`，不经过 shell。请求格式：

```json
{
  "version": 1,
  "audio": "/local/audio.wav",
  "output": "/local/result.json",
  "model": "local-model",
  "engine": "mlx-audio",
  "language": "zh"
}
```

输入音频为单声道 16 kHz PCM16 WAV。进程退出码为 0，并原子写入 `output`：

```json
{ "version": 1, "cues": [{ "start": 1.2, "end": 3.4, "text": "字幕内容" }] }
```

时间单位为秒。输出上限 10 MB、50,000 条；时间必须有限、非负且位于视频范围内，文本按纯文本显示。每次请求只包含当前约一分钟的音频以及前后各一秒上下文。可选 `trim_start` / `trim_end` 指明本段在输入音频中的有效范围；内置适配器按词中点裁掉上下文，自定义适配器结果由后端按字幕中点裁剪，避免跨段重复。输出时间相对本次 WAV，后端转换为整节回放时间。确认无可用人声时可以返回空 `cues`，该段仍记录为完成。取消时子进程会被终止。自定义适配器也应监控父进程退出；内置适配器已实现。

模型接口依据 [MLX Audio Whisper 文档](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/whisper/README.md)。

账号绑定：`GET /learn/api/public/v1/users/me` 的 `id` 经带教学网域名命名空间的 SHA-256 转换后作为本地分区，映射保存在 `subtitle-accounts`，正式字幕为 `subtitles-v2/<account>/<course-video>/subtitles.json`。登录指纹只用于凭证有效性及正在执行任务的取消检查。迁移只处理当前已验证会话的旧目录，不扫描认领其他未知会话；已有账号字幕不被旧副本覆盖。

分段进度与识别引擎指纹保存在同目录 `subtitles.partial.json`，每段原子写入。停止或重启不删除它；继续生成时校验账号、视频内容和模型配置。替换模型或适配器后从头生成，避免拼接不兼容的识别结果。字幕状态带 `document.progress`，界面每三秒刷新并装载新增字幕；导入字幕会替换完整轨道并清除旧分段进度。

## Windows 支持边界

Windows 版可以导入、播放和持久保存 SRT/VTT，现有字幕不会因为缺少识别引擎而被删除。MLX 内置模型与 `install.sh` 仅提供 Apple Silicon Mac 安装；Windows 设置页不展示这条安装命令，也不会尝试运行 Homebrew。

Windows 自定义识别适配器沿用上文协议，配置文件位于 `%LOCALAPPDATA%\petertian\OnePKU\data\subtitles-provider.json`。`python`、`ffmpeg` 和 `adapter` 应填写现有本机文件的绝对路径，JSON 中反斜杠必须转义；例如使用 `C:/.../python.exe`。自定义适配器自行加载本地模型，应用不代为安装 GPU 驱动或上传音频。未提供适配器时，自动生成按钮保持不可用。

本轮未实现或验证 Windows 内置自动语音识别引擎；不能把自定义适配器协议视为已完成的开箱即用自动字幕。
