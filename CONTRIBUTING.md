# 参与贡献

OnePKU 是一个本地运行的北大校园桌面应用。欢迎修 bug、补培养方案数据、接入新的公开通知来源，或改进文档。

## 开发环境

需要 Node.js（20 以上）、Rust stable 与 Xcode Command Line Tools。

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
cargo test -p pku-course --lib --locked
```

## 项目边界

改动前请读 [docs/PRODUCT.md](docs/PRODUCT.md)、[docs/ADOPTION.md](docs/ADOPTION.md) 和 [docs/UX-CONTRACT.md](docs/UX-CONTRACT.md)。几条不会放松的约束：

- 会话凭证只保存在 PKU CLI 的会话目录，可选记住的密码只存系统钥匙串；两者均不返回前端或写进仓库。密码输入仅经独立原生 IPC，不加入可序列化的资源 Request 或缓存。
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
