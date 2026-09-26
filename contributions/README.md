# PKU CLI contribution candidates

Base: pkuinfo/pkucli 0ad6dea1802abc98825dc57b07b75da4dee1c9f4 (MIT).

`pkucli-login-identity.patch` 是基于 OnePKU `bbdec7f` 登录文件的增量：教学网 SSO 使用新 Cookie 容器并核对实际账号身份后才替换会话；树洞 GUI 回调不继承旧 Cookie。包含账号不匹配和无有效账号响应的测试。与下方回放、学期补丁涉及不同文件。回馈上游前需适配上游 GUI 回调接口，尚未提交。

`pkucli-course-read.patch` adds three read-only course commands: `recordings --date --search`, `recording-sessions <course-id>`, and `learning-grades <course-id>`. Outputs are typed JSON, reuse ordinary authorized course sessions, and preserve unpublished or removed recording states. No GUI, desktop session-expiry changes, or media downloader is included.

The isolated checkout used to produce the patch is kept outside this repository (it is a full upstream clone). Three parser tests passed; an actual date/name directory query returned the requested recording course. Full school grading coverage is not established. Global installed `pku` was not modified. No commit was pushed and no PR was created.

`pkucli-bdkj-login.patch` updates the official OAuth callback configuration from HTTP to HTTPS. OnePKU additionally validates the protected login destination and preserves the profile-completion prerequisite; these desktop integration changes are not part of this small configuration patch.

Review the patch file directly. Apply the course patch to the stated base with `git apply --check` before `git apply`.

## Windows portability delta

`pkucli-windows.patch` is an incremental patch against the vendored source in OnePKU commit `ddeb402`, not against the original unmodified upstream SHA above. It adds platform-conditional private-file modes, closes session/cookie writers before replacement, hides Windows ffmpeg consoles, and tests synthetic session/cookie replacement. Paths retain the `vendor/pkucli/` prefix so the patch can be reviewed/applied at the OnePKU root. Adapt these small changes to upstream's current implementation before opening an upstream PR; no upstream PR has been submitted.

## 学期识别与回放缓存增量

`pkucli-semester-labels.patch` 是基于 OnePKU `31beb7c` 的独立学期分组识别修复，包含合成标题回归测试。

`pkucli-replay-cache.patch` 是同一基线上的完整 vendored 增量，包含上述学期修复、稳定账号信息读取、播放与下载共享分片、失败恢复、临时网络错误重试及相关测试。它也包含两个工作区所需的依赖锁文件变更；与学期补丁择一应用，不要顺序叠加。可在该基线的独立 checkout 根目录运行 `git apply --check`，应用后运行 `cargo test -p pku-course --lib --locked`。桌面缓存归属、界面与目录迁移由 OnePKU 核心处理，不包含在此候选补丁中；回馈上游前需适配当前上游接口。尚未向上游提交。
