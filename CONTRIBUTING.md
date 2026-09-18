# 参与贡献

OnePKU 是一个本地运行的北大校园桌面应用。欢迎修 bug、补培养方案数据、接入新的公开通知来源，或改进文档。

## 开发环境

需要 Node.js 24.15+（24 LTS；也支持 22.22.2+ 或 26+）和 Rust stable。macOS 需要 Xcode Command Line Tools；Windows 需要 C++ Build Tools、Windows SDK 和 WebView2，见 [Windows 开发说明](docs/WINDOWS.md)。

```sh
npm ci
npm run tauri -- dev
```

浏览器验收（真实后端）：`npm run build && npm run preview:live`，打开 `http://127.0.0.1:1421`。

提交前跑一遍：

```sh
npm test
npm run typecheck
npm run format:check
npm run verify:tokens
cargo test -p campus-core --lib
```

## 项目边界

改动前请读 [docs/PRODUCT.md](docs/PRODUCT.md)、[docs/ADOPTION.md](docs/ADOPTION.md) 和 [docs/UX-CONTRACT.md](docs/UX-CONTRACT.md)。几条不会放松的约束：

- 凭证只保存在 PKU CLI 的会话目录，不进入前端 JavaScript，不写进仓库。
- 前端只能调用 `campus-core::Request` 里显式列出的命令，没有任意 shell、支付、发帖、选退课接口。
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

## 跨平台贡献

macOS 与 Windows 在同一个仓库、同一条主线上维护。请从最新 `main` 建功能分支，通过 PR 合并，不建立长期分离的 Windows 分支或另复制一份前端。平台差异尽量放在 `crates/campus-core/src/platform.rs` 和 `src-tauri/tauri.{macos,windows}.conf.json`，业务命令和凭证边界保持共享。

`.github/workflows/desktop.yml` 在 PR 中检查 Windows x64 和 macOS Apple Silicon，并上传测试安装包；不会自动发布 Release。两个平台的检查都通过、真实账号只读流程完成后，再由维护者发布。没有硬件或账号验证的部分要在 PR 中明确注明，不能把成功编译描述为完整功能验收。

Windows 移植同时修改了 vendored 会话持久化与 ffmpeg 进程启动；可回馈的增量见 `contributions/pkucli-windows.patch`。不要把个人 Rust/C++ 工具链、安装缓存、账号数据、测试日志或构建产物提交进 Git。
