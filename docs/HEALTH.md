# 健康审计

2026-11-10，对着 `main` 的 `f881bbb` 读的。没有用真实北大账号，也没有在手机或桌面上点过登录。下面「这次改了什么」是本次提交；其余都还在。

## 架构

桌面是 Tauri：React 只发 `campus-core::Request`，Rust 核心调 vendored pkucli、写本机缓存，凭证不进 JavaScript。手机是另一套 Kotlin + Compose，协议从 Rust 抄过去，不链接 `campus-core`。两端真正共用的是 `data/curriculum/` 这份培养方案数据，匹配规则各写了一份（`src/lib/curriculum.ts` 约 1300 行，`CurriculumEngine.kt` 约 770 行）。

产品自己的定位已经写清：单用户、一份本地缓存、会话过期先留着上次的数据（`docs/PRODUCT.md`）。`docs/ARCHITECTURE.md` 还停在「缓存键带账号指纹，换账号即失效」，和现在的代码不一致。

## 正确性

**登录失败会写坏已保存的密码（本次已改）。** 桌面端写明新密码只在登录成功后才进钥匙串（`crates/campus-core/src/auth.rs` 第 71 行）。安卓 `AuthManager.login` 原先在向学校提交之前就 `saveCredentials`，失败时只 `clear` 该服务的会话，不清密码。一次输错会覆盖原来能用的密码，之后所有服务的自动重登都用错的那份。现在改为成功之后才写入，见 `android/app/src/main/java/me/petertian/onepku/data/auth/AuthManager.kt`。

失败时仍然会 `clear` 这个服务的会话（同函数的 `catch`）。教学网登录在换票之后、确认会话之前还会清掉 cookie jar（`loginCourse` 里的 `jar.clear()`）。统一认证直接拒绝时，这个服务会被登出，但密码还在，下次读取可以再重登。比覆盖密码轻，这次没有一起改。

**安卓培养方案和桌面不是同一套规则，学分会算少。** 桌面先按课号匹配，有课号但不在方案里的课计入自主选修，退课和「免修 / 状态异常」不挡住教学网里正在上的同名课（`src/lib/curriculum.ts` 的 `assignByPlan`，以及 `computeProgress` 里只对非 withdrawn / other 做 `seen.add`）。安卓 `CurriculumEngine.assign` 的注释仍是「精确名 → 变体 → 关键词 → 类别」，没有课号，也没有方案外这一步（约第 436–478 行）。`computeProgress` 对每一行成绩都 `seen.add`（第 551 行），所以成绩单上的「W」或「免修」会把本学期同名的在修课丢掉。文件头写着两边要一起改，事实上桌面后来的几提交没有跟过来。

**含「过期」的错误都被当成登录失效。** `crates/campus-core/src/lib.rs` 的 `problem` 先看字符串里有没有「过期」，然后才看「准备已过期」这类更具体的前缀（约第 530–559 行）。后者因此到不了。`downloads.rs` 重试时的「下载记录已过期，请从课程重新下载」（约第 883 行）会变成「登录已失效，请重新登录」。这条请求不在可自动重登的名单里，不会真的去换票，但提示是错的。

**前端的服务映射缺了一截。** `src/lib/api.ts` 的 `serviceFor` 不认 `videos`、`haoxueStatus`、`portalStatus`。换账号时 `resetService` 只清映射得上的查询。`owner()` 里只有 `Videos` 归好学、只有 `PortalDetect` 归门户，其余好学和门户请求落到 `"public"`（`lib.rs` 约第 387–436 行）。`sessions()` 也不列好学（`maintenance.rs` 约第 178 行）。课堂实录重新登录后，界面主要靠 `haoxue-connected` 事件刷新，不靠这张表。

**旧成绩口径可能读到别人的桶。** 没有全局 `gradesScope` 时，`maintenance.rs` 的 `grades_scope` 取第一个 `gradesScope:` 开头的对象（约第 223–231 行）。以前按账号分过桶的话，读到哪一份取决于文件里的顺序。单用户机器上通常只有一份。

## 可以拿掉或收小的东西

- `src/pages/Treehole.tsx` 没有被 `App.tsx` 或测试引用。`docs/PRODUCT.md` 已写明树洞浏览不进界面，底层查询留着。这个页面是剩的。
- `src/pages/Bookings.tsx` 和 `tests/workspaces.test.tsx` 还在，导航里没有。`docs/UX-CONTRACT.md` 写了预约先不发布、底层留着。Rust 的 `bookings.rs` 不该当垃圾删。页面本身可以先不挂。
- `reminders.rs` 仍在 `Request` 里，界面把「提醒」重定向到今日。同样是留着的入口，不是漏网的调用。
- 依赖没有明显的闲置包。前端的 Radix、hls.js、pdfjs、TanStack Query 都在用。体积大的是 `vendor/pkucli`（数据层，该留）和上面那两份培养方案引擎。要变小，先让安卓引擎跟上桌面，而不是再抽一层抽象。

## 构建和测试

仓库里的检查是有的：Vitest、`tsc`、Prettier、设计 token、`cargo test -p campus-core --lib`，安卓是 `./gradlew testDebugUnitTest`。没有覆盖真实登录。

这次实际跑过的：

- `npm test`：32 个文件、160 项通过。
- `npm run typecheck`、`npm run format:check`、`npm run verify:tokens` 通过。
- 镜像自带的 Cargo 1.83 读不了锁文件里的 edition 2024（`block-padding`）。换成 stable 1.99.1，并装上 `libssl-dev` 和 `libdbus-1-dev` 之后，`cargo test -p campus-core --lib --locked` 101 项通过。没有跑 `cargo test --workspace`，也没有打 Tauri 安装包。
- 本机没有现成的 Android SDK。装了 `platforms;android-35` 之后，`./gradlew testDebugUnitTest` 60 项通过，其中包含这次改过的 `AuthManager` 的编译。没有真机，也没有打 APK。

没有用真实账号验收这次的登录改动。安卓单元测试里没有失败登录的用例，所以「输错密码不再覆盖旧密码」是读代码确认的，不是测试打出来的。

## 安全

仓库里没有 `.env`、私钥或云密钥。两份 `globalsign_alphassl_ca_2025.pem`（`vendor/pkucli/crates/common/certs/` 和 `android/app/src/main/res/raw/`）是公开的中间证书，用来补教学网的证书链。测试里的学号是 `2200000000`、`20260001` 这种占位。

以下截图是已登录界面，能看到校园卡数字和课程、作业标题，这里不抄内容：

- `docs/onepku-preview.png`
- `docs/onepku-mac.png`
- `docs/research/concept.png`（同一组数字的概念图）

`docs/research/QA.md` 记录用真实账号点过，正文里没有凭证。单用户缓存是产品决定（`docs/PRODUCT.md`）：同一操作系统用户再登另一个北大账号时，成绩和校园卡快照会留到下一次成功刷新。下载和字幕仍按验证过的教学网身份分开，这条没有被单用户缓存带过去。

## 代理能不能驱动

编码代理有 `AGENTS.md`，边界写得清楚。运行中的应用没有自己的命令行。桌面的可编程面是 `Request` 枚举，外加 `crates/campus-core/src/bin/preview.rs` 里只绑 `127.0.0.1:1421` 的 HTTP。那个进程会拒绝 `CommitSubmission` 和 `TrashLocalMaterial`，其余命令能发。它是给人开浏览器验收的，不是稳定的代理入口。`docs/PRODUCT.md` 把 MCP 写成还没接。安卓没有对应的本地接口。`vendor/pkucli` 自带 CLI，覆盖不到回放、笔记、培养方案和 OnePKU 自己的缓存。

前端 `serviceFor` 和 Rust `owner()` 各写一份，代理加命令时很容易只改一边。培养方案同样是两份实现。

## 两份草稿

都开在 2026-10-14，当时的分叉点是 `9b96a29`。此后 `main` 又走了 13 个提交（培养方案、笔记、更新通道、安卓回放）。

**#7** [Quiet the existing pages and finish the night theme in search](https://github.com/PeterTianbuhan/onePKU/pull/7)。草稿，GitHub 上对当前 `main` 仍是可合并、无冲突。夜间搜索那部分已经在 `main` 里：PR 尖端的 `src/styles/search.css` 和 `main` 没有差别。剩下的是空状态文案、按钮降噪一类，大约 12 个文件。页面后来又改过培养方案和课程，合进去只是一层旧文案。建议关掉，不要为了收尾去重做一遍视觉检查。

**#8** [用保存的手机令牌自动重登一次，并改回单份缓存](https://github.com/PeterTianbuhan/onePKU/pull/8)。草稿，和 `main` 冲突。同一天稍晚的 `d1b5a1e` 已经在桌面做了钥匙串里的手机令牌、每个服务只自动重登一次、以及单用户一份缓存；后面的提交又改了同一批文件。安卓那一半没有落地：`AuthManager.relogin` 仍然不带一次性口令，缓存仍是 `ScopedCache` 按账号分。不要把这个分支变基上来。若手机还需要「存着密钥再重登」，在现在的 `main` 上单独做，不要连着把安卓缓存改回一份。

## 建议先做的五件

1. **S，本次已做。** 安卓只在登录成功后保存密码。失败不再覆盖钥匙串里还能用的那份，自动重登才有机会恢复。
2. **M。** 让 `CurriculumEngine.kt` 跟上 `curriculum.ts`：课号优先、方案外有课号的课进自主选修、退课和状态异常不挡住在修。这是现在学分算错的主要来源。只改 `seen.add` 那一行也能先堵住「免修挡住在修」，课号和方案外仍会漏。
3. **S。** `problem` 不要把所有含「过期」的句子收成登录失效。下载记录过期应保持原来的那句「请从课程重新下载」。
4. **S。** 改掉会带偏下一个代理的文档：`README.md` 第 31 和 79 行仍写安卓没有课程回放，安卓自己的 README 已经有回放，并且把桌面版本写成 v0.12.0（现为 0.12.3）。`docs/ARCHITECTURE.md` 第 45 和 52 行仍写缓存按账号隔离。
5. **M。** 给 `Request` 一个本机命令行（或把 preview 收成明确的代理入口），安卓至少能对同一批读命令脚本化。产品写了 GUI 和代理共用核心，现在只有一个给人看的 HTTP，而且写操作被关掉。没有这个，代理只能改代码，不能替你把数据取出来。

## 这次改了什么

`AuthManager.login` 把 `saveCredentials` 挪到学校登录成功之后。失败路径仍只清除这次尝试的那个服务会话，不碰已保存的账号和密码。`relogin` 继续调用 `login`，成功时会把同一份密码再写一次；失败时不再先把密码写进去。

没有在真机或真账号上登过。前端 160 项、`campus-core` 101 项、安卓 60 项单元测试都通过；安卓这边没有覆盖失败登录的用例。
