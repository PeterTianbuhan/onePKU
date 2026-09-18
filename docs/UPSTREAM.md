# PKU CLI fork boundary

## v0.2 integration

- [pku-coe-notice-helper](https://github.com/ha0xin/pku-coe-notice-helper): portal and dean request contracts adapted into Rust. MIT license retained in `licenses/pku-coe-notice-helper-LICENSE.txt`.
- [PkuClaw](https://github.com/TheOne2006/PkuClaw): consulted cache-first, TTL and stale-data conventions. Runtime remains the vendored PKU CLI; PkuClaw is not invoked.
- [OneTHU](https://github.com/smartThise/OneTHU): reference for information architecture, subscriptions and whole-calendar presentation. No source copied; no explicit repository license found during review.
- [RSSHub](https://github.com/DIYgod/RSSHub): source catalogue used to discover EECS notices. Selectors verified against the official site and independently implemented; no route code bundled.
- Official calendar: [school calendar page](https://simso.pku.edu.cn/pages/ccSchoolCalendar.html), [2026–2027 PDF](https://simso.pku.edu.cn/files/simso/schoolcalendar/2627.pdf), [2025–2026 PDF](https://www.pku.edu.cn/Uploads/File/2025/01/17/u6789e9c75f2f9.pdf). Rendered with PDF.js (Apache-2.0).

Source https://github.com/pkuinfo/pkucli commit 0ad6dea1802abc98825dc57b07b75da4dee1c9f4, MIT (vendor/pkucli/LICENSE).

Vendored source is retained for deterministic builds. Intentional changes: expose typed query APIs; serialize result models; add a noninteractive treehole client and explicit course verification; interpret source deadlines at UTC+08; bound HTTP requests and validate login redirects; surface incomplete course traversals. Original installed CLI is unchanged.

Frontend reads only the campus-core allowlisted commands. Auth tokens never cross into JavaScript. No arbitrary upstream commands are exposed.

Additional implemented fixes:

- Strip Blackboard `contentListItem:` prefixes before fetching assignment details; keep missing details explicit. Include direct `/bbcswebdav/` document links in attachment results.
- Parse source deadlines as Beijing time. Do not infer a deadline when the assignment has none.
- Treehole search uses the existing tolerant record parser because optional `tags_info` sometimes returns an object instead of an array. Missing list/required post fields still fail explicitly.
- Noninteractive treehole login skips the CLI's stdin SMS loop. GUI SMS actions remain explicit. Normal installed CLI behavior is unaffected.
- Desktop course sessions reuse the cookie jar, save server updates atomically with mode 0600, and do not force logout on a synthetic 24-hour local timestamp. The original CLI constructor retains its expiry check.
- Atomic 0600 cookie and session writes; remove response-body excerpts from relevant parse errors and user identity logging from the GUI treehole callback.
- IAAA QR responses are recognized by PNG/JPEG signatures; the live JPEG response misleadingly uses an HTML Content-Type.

Native app commands are explicitly allowlisted in `campus-core::Request`. Financial amounts follow the source transaction type; a positive raw amount is not assumed to be income. The bundled library contains additional upstream commands; the GUI exposes only the explicit first-assignment submission flow described below.

Core error classification now recognizes the campus-card library's exact `登录已失效` wording, selects login recovery and invalidates private resource cache instead of reporting a generic retrieval error. The upstream HTTP/auth implementation is unchanged.

### v0.3.0 增量

继续调用 PKU CLI 现有回放列表、历史课程、校园卡三类统计和树洞成绩接口。桌面适配新增严格月份校验、学期标题解析、分源错误隔离与本地归档。树洞成绩解析缺少课程数组/字段损坏时明确失败，缺失学分不默认为 0。考试数据从上游明确考试文字提取，当前源不可用。没有复制 OneTHU/PkuClaw 的新运行时代码，没有测试上游业务写命令。

### v0.4.0 写操作

复用 PKU CLI 单文件 multipart 作业上传。日常 get_assignment 改为 mode=view；显式提交才获取 newAttempt 表单，校验其 course_id/content_id，上传客户端禁止重定向重放；学校回执另行读取并下载已交附件核对 SHA-256。参考 PkuClaw 公开 Blackboard selector/数据结构独立编写收据解析；未复制其提交实现或引入运行时。rfd 与 fs2 分别用于系统文件选择和本地跨进程日志锁。实际学校写入未在开发验证中执行。

### v0.5.0 学习与预约

- 智云课堂独立目录、全部课次、教学网作业与测验分数新增类型化只读接口；媒体使用原教学网授权并检查发布状态，4 路有序分段下载后 ffmpeg 合并。
- 北大空间新增 GUI 扫码流程。官方 OAuth redirectUrl 改为 HTTPS；通过受保护页面验证 SESSION 登录，不要求旧 JWTUser cookie。时段查询保留个人资料补全提示，不误判登录过期。
- 本地贡献候选是 contributions/pkucli-course-read.patch，基于同一上游 SHA，三条只读 CLI 命令与文档独立打包；独立 checkout 保存在仓库之外。尚未推送或创建 PR，全局 pku CLI 未改动。

### 课程通知与作业反馈

在 vendored PKU CLI 上保留公告原始 ID、课程 ID 和原文地址；课程原文通过原生 WebView 的 Cookie API 复用目标域会话，JavaScript 无凭证接口。根据 PkuClaw 公开 Blackboard 选择器与实际页面独立编写反馈读取模块，按 mode=view 查询分数、反馈、历史尝试与已交文件。历史 URL 重新构建并限制课程/作业范围及只读参数；已交文件只允许明确的 assignment/download 路径，按课程注册后复用下载队列。未复制上游提交实现、未改全局 CLI 或贡献候选。

### Windows 移植增量

- `common/src/session.rs`：仅在 Unix 设置 0600；所有平台在原子替换前关闭临时文件和 Cookie writer。Windows 继承用户配置目录 ACL；会话格式和目录选择逻辑不变。
- `course/src/api/media.rs`：Windows 调用 ffmpeg 时使用 CREATE_NO_WINDOW；参数列表、取消逻辑和网络白名单不变。
- 新增临时目录内的会话/Cookie 覆盖写入测试，不读写真实账号。
- 增量候选见 `contributions/pkucli-windows.patch`；它基于 OnePKU 初始提交的 vendor 快照，而不是可直接套用到裸上游的完整独立 PR。贡献前仍需按当前上游代码移植并跑测试。
