<div align="center">

# OnePKU

一个本地运行的北大校园桌面应用。课程、作业、成绩、通知、校历、空闲教室、校园卡放在一个窗口里，数据只在你的 Mac 上。

![OnePKU 今日页](docs/onepku-preview.png)

</div>

## 能做什么

- **今日**：待交作业与附件、最新通知、校园卡余额。每一块独立刷新，一处出错不影响其他。
- **课程**：按学期分组的全部课程，课程通知、资料、回放、教学网成绩；应用内边下边播，支持倍速、断点续看、离线缓存与本机字幕。
- **作业**：跨课程列表和筛选；已提交作业显示评分、反馈与提交历史；首次单文件提交需逐步确认，以学校回执核对哈希才算成功。
- **成绩**：正式成绩、学分与 GPA，学期筛选；学校未返回 GPA 时按官方规则本地计算并注明。
- **培养方案**：首次打开时按成绩和课程推断年级与专业，可修改；毕业总学分与各大类以圆环显示已获 / 要求，点开看学分系列与课程；大学英语按分级计学分；一键抽出教务部 PDF 里本专业的几页原文。匹配不上的课程手动归类，只存本机。课程详情提供拼好课、课程测评、PKUHUB 的评课入口。
- **通知**：课程、学校、各单位、教务部、信科，以及图书馆活动，可订阅、搜索、已读，内置原文窗口。
- **校历**：学校官方整张 PDF，学年切换与缩放。
- **校园卡与空闲教室**：余额、月度收支与流水、充值入口；按教学楼、日期、节次查空闲教室。
- **设置**：统一账号密码登录、各服务扫码登录、保持登录、缓存管理、字幕组件。

课程资料和回放默认保存在 `~/Downloads/OnePKU/`，可在设置里改到别的文件夹；按学期、课程整理，附来源与 SHA-256。

## 安装

目前只提供 macOS 版本（Apple Silicon）。从 [Releases](../../releases) 下载 `OnePKU.app.zip`，解压后拖进"应用程序"。

应用没有 Apple 公证，首次打开会被系统拦下，按你的系统版本处理：

- **macOS 14 及更早**：在访达中右键 OnePKU，选择"打开"。
- **macOS 15 及更新**：先双击一次让系统弹出提示，然后打开"系统设置 → 隐私与安全性"，在页面底部点"仍要打开"。
- **提示"已损坏，无法打开"**：这是下载隔离属性和临时签名的组合结果，不是文件真的坏了。在终端执行下面这条命令后重新打开：

```bash
xattr -cr /Applications/OnePKU.app
```

之后的版本可以在应用内更新：设置 → 版本与更新 → 检查更新，下载后重新启动即可，不再需要重新处理 Gatekeeper。

可选组件：下载回放为 MP4 需要 `ffmpeg`（`brew install ffmpeg`）；本机生成字幕需要 macOS 14 以上并运行一次 `bash scripts/subtitles/install.sh`，见 [字幕说明](docs/SUBTITLES.md)。播放回放、导入 SRT/VTT 字幕不需要这些。

## 第一次打开

1. 在设置里选择「统一登录」，输入学号和统一身份认证密码，依次连接教学网、树洞和校园卡；也可单独连接某个服务或切换扫码登录。默认勾选记住密码，可取消；密码仅在登录成功后保存在本机系统钥匙串。
2. 应用会根据成绩和课程推断你的入学年份、院系和专业，你可以改，之后随时在设置里改。
3. 回到今日页。默认开启保持登录，应用运行期间每 15 分钟做一次轻量会话检查；读取时发现会话失效且记住了密码，会尝试自动重登一次。动态口令与短信验证仍由你完成。设置中可「忘记密码」。

登录凭证存在 `~/.config/info/<服务>/`，与 [PKU CLI](https://github.com/pkuinfo/pkucli) 共用。如果你已经在用 PKU CLI，打开应用直接复用会话。

## 边界与已知限制

- 没有个人课程时间表：教学网不提供上课时间，应用不按课程名推断。
- 没有选退课、支付、发帖、预约的原生写操作，这些提供原站入口。
- 考试安排来源当前不可用，不显示推断结果。
- 培养方案完成度以教务部公开 PDF 清洗后的数据计算，匹配不上的课程标"待确认"，不假装算清；以学校毕业审查为准。
- 浏览器与应用的登录态目前互相独立，可能需要各自登录。
- 数据存放与不会做的事见 [SECURITY.md](SECURITY.md)。

## 本地开发

需要 Node.js 20+、Rust stable 与 Xcode Command Line Tools。

```bash
npm ci
npm run tauri -- dev
```

构建 Mac 应用（输出 `target/release/bundle/macos/OnePKU.app`）：

```bash
npm run tauri -- build --bundles app
```

浏览器里用真实后端验收：`npm run build && npm run preview:live`，打开 `http://127.0.0.1:1421`。

验证：

```bash
npm test && npm run typecheck && npm run format:check && npm run verify:tokens && cargo test -p campus-core --lib
```

## 项目结构

```
src/                 React 界面（页面、组件、样式 token）
crates/campus-core/  Rust 核心：类型化命令、缓存、认证、下载、回放、写操作
src-tauri/           macOS 容器与原文窗口
vendor/pkucli/       PKU CLI 快照与本地补丁（MIT）
data/curriculum/     培养方案结构化数据（由脚本生成）
scripts/             token 校验、PDF 资源、字幕安装、培养方案清洗
docs/                架构、产品取舍、交互约定、设计 token、上游边界、数据说明
docs/research/       调研与验收记录：能力盘点、服务探查、培养方案接口核对、QA
contributions/       待回馈上游的补丁文件
```

前端只能调用白名单命令；会话 Cookie、令牌和钥匙串中的密码不返回 JavaScript。密码输入仅通过独立原生登录命令提交，不经过资源缓存或浏览器预览 HTTP 接口。架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，产品取舍见 [docs/PRODUCT.md](docs/PRODUCT.md) 与 [docs/ADOPTION.md](docs/ADOPTION.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 参与

欢迎修 bug、补培养方案数据、接入新的公开通知来源。流程和约束见 [CONTRIBUTING.md](CONTRIBUTING.md)。请不要在 issue 或 PR 中提交任何真实账号数据。

## 致谢

OnePKU 建立在这些同学的工作之上，按复用程度排列。完整许可与复用范围见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 和 [docs/UPSTREAM.md](docs/UPSTREAM.md)。

- [pkucli](https://github.com/pkuinfo/pkucli)（pkuinfo team，MIT）：全部校园服务的数据访问运行时，以 vendored 快照加补丁的形式使用。
- [pku-coe-notice-helper](https://github.com/ha0xin/pku-coe-notice-helper)（ha0xin，MIT）：门户与教务部通知协议。
- [PkuClaw](https://github.com/TheOne2006/PkuClaw)（TheOne2006）：缓存约定与 Blackboard 页面结构参考。
- [OneTHU](https://github.com/smartThise/OneTHU)（smartThise）：信息架构与整张校历的呈现方式。
- [RSSHub](https://github.com/DIYgod/RSSHub)（MIT）：北大通知来源目录。
- [PkuCampusAssistant](https://github.com/Deke-yo/PkuCampusAssistant)（Deke-yo）：本地资料整理方式。
- [PDF.js](https://github.com/mozilla/pdf.js)（Mozilla，Apache-2.0）：PDF 渲染。
- 课程评价链接指向 [拼好课](https://www.pinhaoke.love)、[非官方课程测评](https://courses.pinzhixiaoyuan.com/) 与 [PKUHUB](https://pkuhub.cn/)，感谢这些站点的维护者。

## 许可

[MIT](LICENSE)。学校数据的版权与使用条款归北京大学及各原站所有。
