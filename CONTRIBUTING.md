# 参与贡献

OnePKU 是一个本地运行的北大校园应用，macOS / Windows 桌面版与 Android 版住在同一个仓库里。欢迎修 bug、补培养方案数据、接入新的公开通知来源，或改进文档。

## 开发环境

需要 Node.js 24.15+（24 LTS；也支持 22.22.2+ 或 26+）和 Rust stable。macOS 需要 Xcode Command Line Tools；Windows 需要 C++ Build Tools、Windows SDK 和 WebView2，见 [Windows 开发说明](docs/WINDOWS.md)。

```sh
npm ci
npm run tauri -- dev
```

浏览器验收（真实后端）：`npm run build && npm run preview:live`，打开 `http://127.0.0.1:1421`。

### Android 端

`android/` 是独立的 Kotlin + Compose 实现，下面那串桌面验收命令覆盖不到它。需要 JDK 17 与 Android SDK（`compileSdk` 35），提交前跑：

```sh
cd android
./gradlew testDebugUnitTest
```

调试 APK 用 `./gradlew assembleDebug`，产物在 `android/app/build/outputs/apk/debug/`；`android/` 目录有改动时 CI 会构建并上传同名产物，见 `.github/workflows/android.yml`。培养方案数据不在 `android/` 下，构建时由 Gradle 从仓库根 `data/curriculum/` 同步，所以要连着整个仓库一起构建。改了仓库根的 Markdown 仍要跑 `npm run format:check`——两端同样受 Prettier 约束。

提交前跑一遍：

```sh
npm test
npm run typecheck
npm run format:check
npm run verify:tokens
cargo test -p campus-core --lib
cargo test -p pku-course --lib --locked
```

## 项目边界

改动前请读 [docs/PRODUCT.md](docs/PRODUCT.md)、[docs/ADOPTION.md](docs/ADOPTION.md) 和 [docs/UX-CONTRACT.md](docs/UX-CONTRACT.md)。几条不会放松的约束：

- 凭证只保存在本机：桌面端放在 PKU CLI 的会话目录，Android 端放在应用私有目录（密码另存于 Keystore 加密存储）。都不进入前端 JavaScript，不写进仓库。
- 前端只能调用 `campus-core::Request` 里显式列出的命令，没有任意 shell、支付、发帖、选退课接口。Android 端是 Kotlin 侧的对应层，边界一样。
- 读操作要能区分"学校返回空"与"读取失败"；写操作要有确认、回执核对与持久记录。
- 新能力先用真实账号走通，再展示入口。保留底层代码不等于已发布。

## 培养方案数据

培养方案数据在 `data/curriculum/`，由 `scripts/curriculum/` 从教务部公开 PDF 生成。发现错漏时：

1. 优先修 `scripts/curriculum/overrides/` 里对应专业的修正文件，而不是直接改生成结果；
2. 运行 `npm run curriculum:check` 校验结构与学分合计；
3. PR 中写明依据（教务部或院系公布的方案原文页码）。

## 提交约定

- 一个 PR 解决一件事，说明用户能感知的变化和验证方式。
- 不要提交任何真实账号数据：成绩、余额、课程通知正文、截图里的个人信息都算。演示用假数据。
- 文档用中文，界面文案直接描述动作，不加营销语。

## 与上游的关系

`vendor/pkucli/` 是 [pkuinfo/pkucli](https://github.com/pkuinfo/pkucli) 的 MIT 快照加本地补丁，改动记录在 [docs/UPSTREAM.md](docs/UPSTREAM.md)。对上游普适的修复请同时整理成补丁放到 `contributions/`，方便回馈；不要把上游的完整 checkout 放进仓库。

## 分支与 CI

三条线各管各的范围：

- `main` 是集成主线，桌面端与 Android 端的改动最终都落到这里；合并后的 `main` 同时含两套实现，发布 `v*` 标签也从 `main` 出。
- `Desktop` 是桌面端（macOS 与 Windows）的迭代分支，推上去就要能直接拿到双平台测试安装包。
- `Android` 是安卓端的迭代分支，推上去就要能直接拿到调试 APK。

功能分支从最新 `main` 建，通过 PR 合并；不要在 `Desktop` 或 `Android` 上再长期另开平行分支，也不要把只属一端的改动直接推上 `main`。改了 `data/curriculum/` 这类两端共用的数据，要同时想清楚两端的读法——Android 端构建时把它同步进 assets，桌面端在运行时解析。

CI 按路径分工，不看改动落在哪条分支：

- `android/**` 的改动触发 `.github/workflows/android.yml`，构建调试 APK 并上传产物。
- `android/` 之外的改动触发 `.github/workflows/desktop.yml`，在 Windows x64 与 macOS Apple Silicon 上跑检查并上传测试安装包；`android/**`、`docs/**` 与 `*.md` 被它忽略。
- 两个工作流都不会自动发布 Release。发布由维护者打 `v*` 标签触发 `.github/workflows/release.yml`；Release 一旦发布，`android.yml` 也会触发一次，从该标签指向的提交构建 APK 挂到同一个 Release 上，所以发版时两端各自核对产物文件名（`OnePKU.app.zip` 与 `onepku-android-v<Android 版本>.apk`）。只想发 Android 版时用 `onepku-for-android-vX.Y.Z` 这种前缀标签，`release.yml` 的 `if: startsWith(github.ref, 'refs/tags/v')` 不会命中它。
- 两个平台的检查都通过、真实账号只读流程完成后才算验收。没有硬件或账号验证的部分要在 PR 中明确注明，不能把成功编译描述为完整功能验收。

桌面端的平台差异尽量放在 `crates/campus-core/src/platform.rs` 和 `src-tauri/tauri.{macos,windows}.conf.json`，业务命令和凭证边界保持共享。Windows 移植同时修改了 vendored 会话持久化与 ffmpeg 进程启动；可回馈的增量见 `contributions/pkucli-windows.patch`。不要把个人 Rust/C++ 工具链、安装缓存、账号数据、测试日志或构建产物提交进 Git。
