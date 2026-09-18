# Windows 开发与验收

## 当前状态

Windows x64 已有实验性源码适配；macOS 和 Windows 共用一个仓库、一份 React UI 和 Rust 核心。Windows 首批范围是主应用、资料归档、播放器、字幕导入及系统集成，不包含开箱即用的自动语音识别。

**构建成功不等于真实账号功能已验收。** 学校登录、课程读取、在线回放和作业流程需要由账号本人验证；不要把真实成绩、Cookie、令牌或校园卡信息提交到 Git 或公开 issue。

## 开发环境

- Windows x64（本次开发机为 Windows 11）；Windows ARM64 原生包不在本轮范围。
- Node.js 24 LTS，至少 24.15；`package.json` 也允许 22.22.2+ 和 26+。较早版本不满足当前 jsdom 的要求。
- Rust stable，MSVC 工具链 `x86_64-pc-windows-msvc`。
- Visual Studio Build Tools 的“使用 C++ 的桌面开发”，包含 MSVC 和 Windows SDK。
- Microsoft Edge WebView2 Runtime。NSIS 安装器在缺失时按 Tauri 默认策略下载运行时，因此首次安装可能需要联网。

常规安装工具后重新打开 PowerShell：

```powershell
node --version
cargo --version
npm ci
npm run tauri -- dev
```

开发机可能使用项目内忽略的 `.private/` 工具缓存。这不是仓库依赖、不能提交，也不是其他贡献者必须复制的安装方式。

## 检查与打包

```powershell
npm run build
npm test
npm run typecheck
npm run format:check
npm run verify:tokens
cargo test --workspace --locked
cargo test --manifest-path vendor/pkucli/Cargo.toml -p pkuinfo-common --lib --locked
npm run tauri -- build --bundles nsis -- --locked
```

安装包：`target/release/bundle/nsis/OnePKU_<版本>_x64-setup.exe`。

Windows 配置使用当前用户安装模式，不要求把应用安装到系统级 Program Files；Windows 配置文件由 Tauri 自动合并，无需手工覆盖公共配置。主程序不弹控制台，ffmpeg/字幕子进程也不弹命令窗口。

开发包未做 Windows 代码签名，SmartScreen 可能提示未知发布者。只测试自己构建或维护者明确提供的文件，不要为运行开发包全局关闭 Defender/SmartScreen。最终发布应考虑代码签名，并明确列出 SHA-256。

macOS 仍使用 `npm run tauri -- build --bundles app -- --locked`，不要求在 Windows 上交叉构建 Mac 安装包。

## 平台差异

| 项目          | Windows 行为                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| 本地数据      | 使用 Known Folders / `directories`；具体位置见 `SECURITY.md`                                         |
| 资料目录      | 系统“下载”目录下 `OnePKU`，保留原件与来源 sidecar                                                    |
| 文件权限      | 继承当前用户目录的 NTFS ACL；Unix 的 0600/0700 仅在 Unix 设置                                        |
| 资料安全      | 拒绝重解析点/目录联接；用卷 ID 和文件 ID 检查身份；禁止设备名与备用数据流文件名                      |
| 打开文件/网页 | Windows Shell API，目标不拼进 cmd.exe 命令                                                           |
| 删除资料      | 系统回收站，仍需界面确认，不永久删除学校原件                                                         |
| 操作日志      | 写入、同步并关闭临时文件后替换；Windows 使用带 write-through 的原生移动 API，不对目录调用 Unix fsync |
| 搜索快捷键    | Ctrl K；macOS 保持 ⌘ K                                                                               |
| 下载 MP4      | 需要用户自行提供 PATH 中的 `ffmpeg.exe`，应用不自动安装                                              |
| 自动字幕      | 内置 MLX 安装仅限 Apple Silicon；Windows 保留导入/持久化和高级本机适配器协议                         |

下载目录不要放在共享可写文件夹。对重解析点的拒绝是保守选择，可能使联接/部分云盘目录不可用；不为方便而绕过这项检查。

## 本轮本机验证（2026-09-18）

环境：Windows 11 x64，Node.js 24.21.0，Rust 1.98.1 / MSVC。以下是本地检查和用户试用反馈；用户反馈不等于逐项发布验收记录：

- 前端 22 个测试文件、73 个测试通过；类型检查、Prettier、design tokens 检查通过。
- Rust workspace：核心 46 个、桌面层 3 个测试通过；vendored 会话/Cookie 保存 2 个测试通过，均使用合成数据或临时目录。
- `npm run tauri -- build --bundles nsis -- --locked` 成功，生成 Windows x64 当前用户安装包；本地包未签名。
- 浏览器连接真实本地 Rust 预览后端：今日页/设置页正常渲染，Ctrl+K 打开搜索，Windows 显示内置字幕引擎不可用且不提供 Mac 安装命令。浏览器控制台只有预览服务缺失 `favicon.ico` 的 404；未做登录或学校写操作。
- Windows/macOS CI 配置已添加并做 YAML 解析检查；远端运行结果以 PR 中的检查为准。
- 首次自动启动曾受到执行环境限制；随后经用户要求，成功启动 Windows 原生程序并确认窗口存在。用户手工试用反馈所走流程均正常，但没有逐项记录覆盖范围，下面的安装/卸载与功能清单仍需保留。macOS 实机回归尚未执行。

## 发布前手工验收清单

- [ ] 在普通用户账户安装、启动、卸载；缺失 WebView2 时提示/安装正常。
- [ ] 扫码登录、关闭重开、保持会话；凭证不出现在前端或日志。
- [ ] 课程、作业、成绩、通知、培养方案和原文窗口可访问；退出登录后不串账号。
- [ ] 中文/空格/特殊字符资料名；导入、打开、回收站恢复及同名不同内容归档。
- [ ] 在线回放、离线缓存、倍速/全屏、断点续看；窗口无后台控制台闪烁。
- [ ] 导入 SRT/VTT、字幕偏移、重启后复用；未配置引擎时不出现 Mac 安装命令。
- [ ] 如需验收作业提交，由本人明确选择测试作业逐步确认；不自动提交或测试支付/选课。
- [ ] macOS CI 通过，并在真实 Mac 上复查启动、资料和字幕组件。

CI 上传的是测试构建，不自动创建 Release。正式发布前必须补齐上述验证，不能把本机单元测试报告当成学校服务的集成验收。
