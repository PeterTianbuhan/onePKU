---
version: alpha
name: OnePKU
description: 纸与朱砂——安静、直接的北大校园桌面工作台
colors:
  primary: "#8F2338"
  primary-soft: "#F6ECEB"
  on-primary: "#FFFFFF"
  text: "#1D1B19"
  muted: "#726D66"
  faint: "#A8A29A"
  background: "#FBFAF7"
  surface: "#FFFFFF"
  sidebar: "#F4F2ED"
  border: "#E7E3DB"
  border-strong: "#D5D0C6"
  success: "#2F7A5B"
  success-soft: "#EAF4EE"
  warning: "#8A5F17"
  warning-soft: "#FAF3E3"
  danger: "#B03A32"
  danger-soft: "#FBEDEB"
  hover: "#F1EEE8"
  overlay: "#1D1B1966"
  scrollbar: "#CDC8BE"
  pigment-1: "#B5463C"
  pigment-2: "#9A6233"
  pigment-3: "#8F7420"
  pigment-4: "#3F7F6B"
  pigment-5: "#3D6C97"
  pigment-6: "#6E5A8E"
darkColors:
  primary: "#DC7C8A"
  primary-soft: "#2E2022"
  on-primary: "#1B1012"
  text: "#ECE8E1"
  muted: "#A19B92"
  faint: "#6E6961"
  background: "#151413"
  surface: "#1D1C1A"
  sidebar: "#191817"
  border: "#2C2A27"
  border-strong: "#3F3C37"
  success: "#6DB592"
  success-soft: "#1B2A22"
  warning: "#D3A55C"
  warning-soft: "#2B2416"
  danger: "#E5786F"
  danger-soft: "#321E1C"
  hover: "#262421"
  overlay: "#000000A6"
  scrollbar: "#4A4640"
  pigment-1: "#E08A80"
  pigment-2: "#D2A070"
  pigment-3: "#D6B865"
  pigment-4: "#7FC0A8"
  pigment-5: "#86B2DA"
  pigment-6: "#B09FD0"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
  serif:
    fontFamily: 'ui-serif, "New York", "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, "SimSun", serif'
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
rounded:
  DEFAULT: "12px"
  sm: "8px"
  lg: "18px"
spacing:
  section-gap: "20px"
  page-max: "1120px"
  sidebar-width: "216px"
  page-pad: "44px"
components:
  button: {}
  card: {}
  dialog: {}
  input: {}
  resource: {}
  table: {}
---

# OnePKU 设计系统：纸与朱砂（燕园日课）

## 总览

北大学生每天打开的校园工具。主要场景是 macOS 桌面，中文内容，校园时间统一 Asia/Shanghai；面向 Peter 自己用。

整套界面当作一本线装的日课来做，只有三样东西：**纸**（带细颗粒的暖白纸面，内容直接排在纸上，不套盒子）、**墨**（近黑的字、宋体的标题和数字、标题下的墨线、水墨的湖景）、**朱砂**（印章、当前页的书签、今天的日子、关键动作）。未名湖与博雅塔是唯一的画，只出现在两处：今日页的页头（水墨，随时刻换色）和校园卡的卡面（朱红）。其余地方不放装饰图，也不堆指标卡片。

本文件是 token 唯一来源。`scripts/tokens.mjs` 生成 `src/styles/tokens.css`，`npm run verify:tokens` 检查漂移。UI 归属见 UX-CONTRACT.md。改界面用 `npm run demo`：全部数据是虚构的，不需要登录。

## 颜色

- `background` 是纸（页面底色），`surface` 是贴在纸上的东西：输入框、按钮、弹窗、菜单，`sidebar` 比纸略深。一节一节的内容不用 `surface` 垫底，直接排在纸上，用线分开：`border` 是行间的细线，`border-strong` 只给输入框和按钮。
- `text` 是墨，`muted` 是次要文字，`faint` 是占位、分隔符和图标的最浅一档，不用来写需要读的字。
- `primary` 是朱砂（北大红），只用在：印章、当前选中项的图标、主要按钮、未读点、余额数字、紧迫的截止时间。`primary-soft` 是它的底色。`on-primary` 是压在朱砂上的字。
- `success` / `warning` / `danger` 表示状态，始终配文字，各有一个 `-soft` 底色。
- `pigment-1` 到 `pigment-6` 是六种国画颜料色（朱砂、赭石、藤黄、石绿、石青、黛紫），只用来给课程和服务的首字印记上色（`CourseGlyph`、设置页的服务标识），同一个名字永远是同一个颜色。它们不表示状态。

深色是同一套语义色的另一组取值（`darkColors`），挂在 `html[data-theme="dark"]` 上，由 `src/lib/theme.ts` 按「跟随系统 / 浅色 / 深色」切换并同步原生窗口主题。深色下：朱砂提亮，印章保持原色；今日页头的湖景换成浅墨色画在深纸上；校园卡卡面是一件「印出来的东西」，保持白底朱红不变；视频播放器与校历画布本来就是固定底色。

有几样不进令牌，写在 `base.css` 里：`--shadow-sm/md/lg` 由墨色按透明度混出来；`--seal` 是印泥（印章、今天的日子、当前页的书签），不随主题变浅；`--rule` 是墨线（一节的标题线、清单的顶线、时间尺）；`--grain` 是纸纹（一张内联 SVG 噪声，浅色下是深颗粒、深色下是浅颗粒，铺在整个窗口上，弹窗在它上面）；`--gutter` 是书口的浓度。

## 字

- `sans` 是系统中西文字体，正文 14px / 1.6，辅助信息 12.5px，最小 12px（柱状图刻度等纯数字标注可到 10.5px）。
- `serif` 是宋体（macOS 上西文和数字落在 New York，中文落在宋体-简）。只用在三类地方：标题（页面标题 h1 31px，每一节的标题 h2 17px，今日页的日子 124px）、要被一眼读到的数字（余额、GPA、学分、分数、日期）、弹窗、学期、课程名这类「题目」。正文、按钮、表格不用宋体。
- 数字一律 `tabular-nums`，宋体数字加 `lining-nums`。
- 不下载字体。Windows 上宋体回落到 Georgia + SimSun。

## 版式

- 侧栏 216px，可收成 60px 的图标条；内容最宽 1120px，左右留白 44px，区块间距 20px。1100px 以下留白收到 28px，900px 以下双栏变单栏，640px 以下导航横排到顶部（只为浏览器预览）。桌面原生最小宽度 760px。
- macOS 上标题栏与内容融合（`tauri.macos.conf.json` 的 `titleBarStyle: Overlay`）：红绿灯浮在侧栏左上，侧栏顶部多留 50px，窗口顶部 30px 是拖动区（`.titlebar`，`data-tauri-drag-region`）。Windows 保持系统标题栏。
- 侧栏和正文像摊开的两页：侧栏靠近中缝的一侧略暗（书口）。每页的标题下是一道文武线（一粗一细）。
- 今日页是一幅画（`TodayHero`）：左边是日子，中文数字的大字，旁边竖排题款（农历年、月、日）和一方节气印；右边是未名湖的水墨。天上画太阳或月亮，位置按北京时刻从左走到右，日出日落按燕园的经纬度算，月亮按月相画；晨、昼、昏、夜各有一套墨色。历法与天象的计算在 `src/lib/almanac.ts`，画面每分钟对一次表。
- 画的下沿是两周的时间尺（`DeadlineRuler`）：一天一格，今天是朱砂圆点，没交的作业按截止日立在尺上，用课程的颜色，点了进作业。下面左栏作业与通知，右栏余额、本学期课程和常用入口，都直接排在纸上。
- 通知是左列表右正文，900px 以下分步呈现。校历展示学校原始整张 PDF。
- 表格在区域内横向滚动，不挤压页面；刷新保留内容高度。

## 层次

纸面上没有卡片：一节内容是一个宋体标题、一道墨线，下面的行用细线隔开。只有三种东西有明显的阴影：悬停的课程色笺、浮层（菜单、说明）和弹窗。弹窗后面的遮罩带轻微模糊。侧栏固定，主体独立滚动。仍然保留白底的只有本身是「一张东西」的块：作业详情、校历画布、培养方案的圆环。

## 形状

控件 8px，卡片 12px，弹窗 18px，胶囊（标签页、徽标、状态）全圆角。图标 Lucide，导航 17px、行内 15–16px，线宽 1.6。

## 组件

共享的 Button、Resource、Empty、Modal、Search、Pager、ActionMenu、AttachmentRow 由 `src/components/ui.tsx` 拥有；样式按用途分文件：`base.css`（重置、排版、动效）、`shell.css`（侧栏与页面）、`controls.css`（通用控件）、`pages.css`（各页）、`course.css`（课程与作业详情）、`curriculum.css`、`replay.css`、`search.css`。

- **按钮**：默认白底细边；主要动作朱砂底；`quiet` 无边。一列里重复出现的主要动作（回放列表每行的「播放」）用浅朱砂底，悬停才变实心。图标按钮有 aria-label。
- **标签页与分段选择**（`.tabs`、外观三选一）：同一种灰底胶囊，选中项是一块白色浮片。
- **Resource**：每块数据一节，不套盒子：标题（宋体）下面一道墨线。初始加载显示流光骨架；成功显示数据，更新时间放在刷新按钮的 title 里；失败保留旧数据并提示；认证失败给出重新登录。刷新按钮平时半透明，悬停这一节时显现，刷新中只旋转图标。空状态只来自成功的空结果。
- **导航**：当前页左边一条朱砂书签，底上一抹淡朱砂，图标变朱砂色。
- **印章**（`.seal`、侧栏的「未」）：印泥色底、白字，带一点毛边（`#seal-rough` 滤镜，定义在 `App.tsx`）。今日页的节气印随节气换字。
- **日期印**（`DueStamp`，今日页和作业页的作业行左侧）：星期在上、日子在下；24 小时内截止是朱砂底，已截止是空心，没有截止时间只留一支笔。
- **课程印记与色笺**：课名首字 + 颜料色（`CourseGlyph`、`coursePigment`）。今日页和时间尺上是小印记；课程页一门课一张色笺，课名在上，首字淡淡地压在角上。
- **成绩走势**：成绩页头右侧，各学期 GPA 连成一条墨线，每学期一个朱砂点；不足两个学期不画。
- **空闲教室**：一格一节课，石绿是空闲、留白是占用，不再用 ✓ ×；读屏文字保留。
- **弹窗**：Radix Dialog，焦点锁定、Escape 关闭、关闭后恢复触发焦点。
- **下拉框**：原生 select，统一外观和箭头。

动效：反馈 160ms，页面与弹窗进场 200–240ms（上浮 6px + 淡入），今日页的湖景像墨晕开一样淡入（1.2s），日月从地平线下升到位（1.6s），加载旋转 800ms；`prefers-reduced-motion` 下全部取消。滚动条细且随内容出现。金额显示两位小数，日期按北京时区。提示内容不包含 token、cookie 或原始服务错误 URL。

## 要与不要

- 要：每块资源独立刷新、错误局部呈现，其他资源正常使用。
- 要：用原始课程与通知内容，明确未更新的范围。
- 要：页头摘要只说已经读到的数（待交作业数、未读通知数），没读到的不出现。
- 不要：把网络失败呈现为没有作业。
- 不要：在页头和卡面之外再放装饰图；不要用颜料色表示状态；不要让朱砂出现在一屏里的太多地方。
- 不要：给一节内容套白底圆角的盒子；要分开就用线和留白。
- 不要：添加营销说明或不对应真实数据的数字。

## 素材

湖景是一张生成的朱红线描（`src/assets/campus-card-school.webp`，来历见 research/ASSETS.md），白底，校园卡卡面直接用它。今日页用的是从它提出来的墨稿 `src/assets/weiming-ink.webp`：只有透明度（墨的浓淡），没有颜色，裁掉了右边的华表和上面的大片天空，作为遮罩让 CSS 按时刻染色。重新出墨稿的办法：取每个像素绿、蓝通道里较暗的一个，越暗墨越浓。余额、状态与有效期用真实文本覆盖，图像不承载任何个人信息。
