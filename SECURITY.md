# 安全说明

## 数据存放位置

| 内容                     | 位置                               | 说明                                       |
| ------------------------ | ---------------------------------- | ------------------------------------------ |
| 登录凭证（Cookie、令牌） | 平台用户配置目录（见下文）         | 与 PKU CLI 共用，不进入前端                |
| 资源缓存                 | 应用缓存目录 `resources-v1.json`   | 按账号指纹隔离，最长 30 天，可在设置中清除 |
| 偏好、已读、订阅         | 应用配置目录 `preferences.json` 等 | 本机文件                                   |
| 下载的课件与回放         | `~/Downloads/OnePKU/`              | 附来源与 SHA-256 元数据                    |
| 作业提交暂存             | 应用私有目录                       | 未发送文件在取消、过期或重启时清理         |

平台路径由 `directories` 与 Windows Known Folders API 决定，不手工拼接用户名字：

- macOS 凭证：`~/Library/Application Support/info/<服务>/`。
- Windows WebView2 独立保存网页运行数据（可能含网页会话和缓存）：`%LOCALAPPDATA%\me.petertian.onepku\EBWebView\`。它与下述 Rust 业务数据目录不同，不要把该目录作为诊断资料公开发送。
- Windows 凭证：`%APPDATA%\info\config\<服务>\`；OnePKU 缓存：`%LOCALAPPDATA%\petertian\OnePKU\cache\`；字幕和操作日志：同级 `data\`；偏好：`%APPDATA%\petertian\OnePKU\config\`。
- Unix 新建私有文件保留 0600、私有目录保留 0700；Windows 使用当前用户目录继承的 NTFS ACL，不把 POSIX mode 位误称为 Windows 权限。没有添加 Everyone/Users 授权，也不修改用户目录现有 ACL。若用户把目录共享给其他账号，应用不承诺消除该共享访问。
- 归档读取拒绝符号链接；Windows 额外拒绝重解析点（含目录联接），保留文件身份和内容校验。

应用不保存 IAAA 密码。扫码与短信验证由用户完成。

## 应用不会做的事

- 不向学校以外的服务器发送任何账号数据；没有遥测、没有崩溃上报。
- 不自动执行支付、发帖、选退课、预约。作业提交需用户逐步确认，且只在学校回执与本地副本哈希一致时才标记成功。
- 后台保活只做轻量会话检查，不发送短信、不重试写操作。
- 内置原文窗口只把与目标学校域名匹配的会话 Cookie 注入原生 WebView，JavaScript 拿不到凭证。

## 报告漏洞

请不要在公开 issue 里贴出可复现凭证泄露的细节。通过 GitHub 私密漏洞报告（Security Advisories）联系维护者，或先发一个只写"发现安全问题，请私聊"的 issue，维护者会跟进。

收到报告后会先确认影响范围，再修复并在 CHANGELOG 中说明。涉及上游 PKU CLI 的问题会同时通知上游。
