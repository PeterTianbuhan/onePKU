# 架构说明

给想读懂整个项目的人。按"一次请求怎么走"来讲，再列各层的职责与文件。

## 一次请求的路径

```
React 页面  ──useResource({kind:"scores"})──▶  src/lib/api.ts  call()
                                                     │  Tauri IPC invoke("campus", {request})
                                                     ▼
                                    src-tauri/src/main.rs  campus()   ← 只接受 label 为 main 的窗口
                                                     │  spawn_blocking
                                                     ▼
                                    crates/campus-core  Core::call() → execute() → dispatch()
                                                     │
              ┌──────────────────────────────────────┼──────────────────────────────────┐
              ▼                                      ▼                                  ▼
   vendor/pkucli 各 crate                  本地文件（下载、缓存、偏好）             公开站点（通知、校历）
   course / treehole / campuscard / …      ~/Downloads/OnePKU、应用缓存目录         reqwest + scraper
```

返回值统一是 `Envelope`：`data`、`updatedAt`、`stale`、`error{code,message}`、`warnings`、`generation`。前端不解析异常，只看这几个字段。

## 各层职责

### 前端 `src/`

- `App.tsx`：侧栏、页面切换（hash 路由，见 `lib/navigation.ts`）、全局登录弹窗、下载面板。
- `pages/`：今日、课程、作业、成绩、通知、校历、生活（校园卡、空闲教室）、设置。`Treehole.tsx` 与 `Bookings.tsx` 保留代码但未挂到导航。
- `components/ui.tsx`：`Button`、`Resource`、`Empty`、`Modal`、`Search`、`Pager`。`Resource` 负责骨架、旧数据标注、局部错误与"重新登录"按钮，所有数据块都包在它里面。
- `lib/api.ts`：`call`、`useResource`（TanStack Query，5 分钟 staleTime）、`action`、`openOfficial`，以及请求到服务的映射 `serviceFor`，登录变化时按服务清空查询。
- `lib/grades.ts`：GPA 与加权平均的官方公式。`lib/curriculum.ts`（培养方案匹配）与此并列。
- `styles/tokens.css` 由 `docs/DESIGN.md` 头部的 YAML 生成，`npm run verify:tokens` 校验漂移。

前端拿不到已保存的密码、会话 Cookie 或令牌。用户输入的密码经独立原生 IPC 交给 Rust，不进入资源 Request、查询缓存、日志或浏览器预览 HTTP；其余操作通过白名单命令、系统文件选择器和原文窗口完成。

### 桌面容器 `src-tauri/`

- `main.rs`：注册 `campus`、三个文件选择命令和 `open_browser`。所有命令先检查调用窗口标签。
- `browser.rs`：原文窗口。目标是教学网时，从核心取匹配该 URL 的 Cookie 注入原生 WebView 的 Cookie 存储；其他站点用独立会话。JavaScript 没有读取 Cookie 的接口。
- `capabilities/`：主窗口只开放全屏两项权限。

### 核心 `crates/campus-core/`

`lib.rs` 里的 `Request` 枚举是前端能调用的全部命令，`serde(tag="kind")` 与前端 `kind` 字段一一对应。`owner()` 决定一个请求属于哪个服务账号（course / treehole / campuscard / bdkj / public），`fingerprint()` 用该服务的会话文件做账号指纹，缓存键和下载目录都带这个指纹，换账号即失效。

| 模块                          | 职责                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `lib.rs`                      | 请求枚举、`execute()` 的超时（75 秒）、缓存读写与旧数据回退、错误分类      |
| `auth.rs`                     | 账号密码与扫码登录、短信二次验证、只读认证恢复，会话写入 PKU CLI 目录                  |
| `maintenance.rs`              | 保持登录：15 分钟一次的空闲会话检查、失败退避、偏好持久化                  |
| `storage.rs`                  | `resources-v1.json` 持久缓存，30 天上限，按账号隔离，启动时恢复            |
| `study.rs`                    | 课程、回放列表、教学网成绩、课程通知，以及给原文窗口的 Cookie 提取         |
| `downloads.rs`                | 下载队列（3 并发、200 任务上限）、去重、版本号、SHA-256 元数据、HLS 转 MP4 |
| `materials.rs`                | 本机资料导入、打开、移到废纸篓                                             |
| `playback.rs`                 | 边下边播：本机随机端口媒体服务、分片缓存、观看位置；签名地址与密钥只在内存 |
| `subtitles.rs`                | 可选字幕组件的检测、分段识别、导入                                         |
| `writes.rs`                   | 作业首次提交的暂存、确认、回执核对、待核对记录                             |
| `news.rs`                     | 学校/单位/教务/信科/图书馆通知抓取与正文清洗、校历 PDF、外链打开           |
| `reminders.rs`、`bookings.rs` | 保留代码，界面已撤下                                                       |
| `bin/preview.rs`              | 浏览器验收用的本机 HTTP 服务，把 `/api` 转给同一个 `Core`                  |

培养方案没有独立的 Rust 模块：`data/curriculum/` 的静态 JSON 由前端 `lib/curriculum.ts` 按需加载并与成绩、课程匹配，不联网；用户资料（年级、方案、手动归类）通过 `maintenance.rs` 的 `profile` / `setProfile` 请求走 Preferences 通道存本机。

### Tauri 插件

除 `campus` 命令外，前端只多了两个官方插件：`updater`（检查与安装更新，地址与公钥在 `tauri.conf.json`）和 `process`（更新后重启）。权限在 `src-tauri/capabilities/main.json` 逐条列出。

### 上游 `vendor/pkucli/`

MIT 快照，提交 0ad6dea。本地补丁只做四类事：暴露类型化查询、序列化结果模型、非交互式树洞登录、放宽人为的 24 小时本地过期。逐项记录在 [UPSTREAM.md](UPSTREAM.md)。可回馈的部分以补丁形式放在 `contributions/`。

## 数据与目录

应用程序安装位置与用户数据目录分开。具体平台路径见 [SECURITY.md](../SECURITY.md)，不要按安装路径推断数据路径，也不要把开发仓库当成用户数据目录。

| 内容                     | Windows 默认位置                                     |
| ------------------------ | ---------------------------------------------------- |
| PKU CLI 会话与 Cookie    | `%APPDATA%\info\config\<服务>\`                      |
| 资源与回放分片缓存       | `%LOCALAPPDATA%\petertian\OnePKU\cache\`             |
| 偏好、用户资料           | `%APPDATA%\petertian\OnePKU\config\preferences.json` |
| 字幕、操作记录与作业暂存 | `%LOCALAPPDATA%\petertian\OnePKU\data\`              |
| 下载与课程资料           | 系统下载目录下 `OnePKU/<学期>/<课程>/`               |
| WebView2 网页运行数据    | `%LOCALAPPDATA%\me.petertian.onepku\EBWebView\`      |

Rust 核心使用 `directories` 查询操作系统目录；Tauri/WebView2 有单独的网页运行数据目录。Windows 私有文件继承当前用户目录的 ACL，Unix 私有文件权限另行设置。登录凭证和网页会话均不得提交或作为公开诊断附件。

## 不变量

这些是代码评审时要守住的：

1. 前端只调用 `Request` 里的命令；新增命令要同时决定 `owner()`、是否 `cacheable()`、是否需要登录。
2. 会话凭证只在核心与 PKU CLI 会话目录之间流动；可选记住的密码只存系统钥匙串，不返回前端。原文窗口的 Cookie 注入只对目标域。
3. 读失败保留同账号旧数据并标 `stale`；认证失败清空私有缓存并让 `Resource` 显示重新登录。
4. 写操作要有持久记录、幂等 ID、回执核对；不自动重发。
5. 空状态只来自成功的空结果。部分失败要进 `warnings`。
6. 时间统一 Asia/Shanghai；来源没有时间就不推断。

## 测试

- `tests/*.test.tsx`：vitest + Testing Library，mock `call()` 返回 `Envelope`，测页面与 `lib/` 的纯函数。
- `cargo test -p campus-core --lib`：解析器、缓存策略、保活退避、下载去重、写操作状态机。
- `docs/research/QA.md`：用真实账号做的手工验收记录，不含个人数据。
