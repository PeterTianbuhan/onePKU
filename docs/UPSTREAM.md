# PKU CLI fork boundary

## 桌面统一登录

交互参考 Northodieart 的 [Android PR #2](https://github.com/PeterTianbuhan/onePKU/pull/2)，审阅版本 `25662d9c0fab99081e76192808349405a328c948`。沿用现有 Rust IAAA RSA 和各服务回调，不引入 Kotlin 网络层。桌面增量包括逐服务结果、可选系统钥匙串、只读认证恢复和原生密码 IPC。

`pkucli-login-identity.patch`：教学网用全新 Cookie 容器建立 SSO，通过 `/learn/api/public/v1/users/me` 确认身份，密码登录须与输入账号一致，再保存会话；树洞 GUI 登录也不继承旧 Cookie，避免回调失败时读到旧 token。补丁基于 OnePKU `bbdec7f` 的两个登录文件，可独立应用；尚未回馈上游。

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
### 学期分组识别

教学网当前课程分组补充识别「本学期」与不区分大小写、允许换行的英文标题；「非当前」和历史分组不再因包含 Current/当前而误判。增量及合成标题回归测试见 `contributions/pkucli-semester-labels.patch`，以本次修改前的 OnePKU vendor 快照为基线，回馈上游前需核对上游版本。此修复仍以学校分组为准，不按最新课程年份猜测在修状态。

### 回放下载恢复

`course/src/api/media.rs` 为桌面下载接收独立的恢复目录：完整 TS 分片原子落盘，失败/取消保留；缓存标识绑定播放列表并忽略临时 URL 查询签名，不落盘 URL 或密钥。短暂网络失败、429、5xx 最多尝试三次，401/403 保留明确提示；启动下载前检查 ffmpeg。新增中断恢复、损坏/HTML 分片拒收、临时签名更新和错误脱敏测试。仅修改 OnePKU 的 vendored 实现，未更新全局 CLI 或提交上游。

播放与 MP4 下载现在共用恢复目录及播放列表指纹，通过进程内的异步分片锁合并并发请求；原子落盘后供两者读取，取消等待不会锁死后续请求。旧播放缓存只在账号、课程、视频及指纹匹配时导入，校验完整 TS 后优先硬链接；播放状态同步读取下载缓存。新增并发仅请求一次、取消恢复、旧缓存复用及下载分片无网络播放回归测试。

完整 vendored 增量整理在 `contributions/pkucli-replay-cache.patch`，基线为 OnePKU `31beb7c`；其中已包含学期分组修复，不能再叠加独立学期补丁。可在该基线运行 `cargo test -p pku-course --lib --locked`，覆盖共享下载与恢复逻辑；主工作区测试本身不会运行依赖包的单元测试。
