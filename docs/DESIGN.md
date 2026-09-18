---
version: alpha
name: OnePKU
description: 安静、直接的北大校园桌面工作台
colors:
  primary: "#8F2338"
  primary-soft: "#F8EFF1"
  text: "#24272D"
  muted: "#71747D"
  background: "#FFFFFF"
  sidebar: "#F6F7F9"
  border: "#D4D6DC"
  success: "#32785A"
  success-soft: "#EDF6F0"
  warning: "#8A621F"
  warning-soft: "#FBF5E8"
  danger: "#A92D3C"
  hover: "#F3F4F6"
  overlay: "#24272D66"
  scrollbar: "#B8BBC3"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
rounded:
  DEFAULT: "10px"
  sm: "6px"
  lg: "16px"
spacing:
  section-gap: "24px"
  page-max: "1180px"
  sidebar-width: "204px"
  page-pad: "40px"
components:
  button: {}
  card: {}
  dialog: {}
  input: {}
  resource: {}
  table: {}
---

# OnePKU Design System

## Overview

北大学生每天打开的校园工具，参考 OneTHU 的信息组织与 research/concept.png 的白底、浅灰侧栏、枣红选中态。主要场景为 macOS 桌面，中文内容和 zh-CN 界面，校园时间统一 Asia/Shanghai。北大用户需求来自本次用户明确委托；不推广到未验证的人群。产品语气直接，按钮描述动作。枣红只用于当前选择和关键操作，避免营销首屏或仪表盘指标堆积。

本文件是 token 唯一来源。scripts/tokens.mjs 生成 src/styles/tokens.css；npm run verify:tokens 检查漂移。UI 归属见 UX-CONTRACT.md。

## Colors

background 白色承载内容，sidebar 浅灰区分导航，border 仅用于区域边界。primary 表示当前页面、日期和主要动作，primary-soft 用作导航与通知选中底色；success/warning/danger 表示状态并始终配文字。使用系统浅色显示；不宣称暗色支持。焦点为 primary 实线外圈，disabled 降低不透明度但保留可读文字。

## Typography

sans 使用系统原生中西文字体，不下载字体。正文 14px / 1.65，辅助信息 12px，分区标题 16px / 600，页面标题 30px / 650；余额 38px 使用 tabular-nums。正文限制长行，详情保留换行和自动断词。无日文 ruby 或斜体排版要求。

## Layout

v0.2 导航按学习、校园、生活分组，今日聚焦作业、通知和余额。按用户约定撤下个人课程时间表。通知采用左列表右正文，小于 900px 时分步呈现并保留返回；来源、已读与搜索均为直接操作。校历展示学校原始整张 PDF，提供学年与缩放。新增区域复用现有 token；阅读正文 15px/2，标题 23px。

204px 固定侧栏，内容上限 1180px，左右留白 40px。今日左右为 1.8:1，24px 区域间距；900px 以下单列，侧栏 164px，页面留白 24px；手机预览 640px 以下导航转为顶部横排。桌面原生最小宽度 760px。表格在区域内横向滚动，不挤压页面；刷新保留内容高度。

## Elevation & Depth

正文无阴影；淡边线与留白划分层级。仅 Radix 模态框使用柔和阴影和遮罩。侧栏固定，主体独立滚动。无玻璃效果。

## Shapes

控件 6px，分区 10px，模态框 16px 圆角。图标 Lucide 18px、1.7px 线宽，与文本对齐；不添加大面积图标卡片。

## Components

共享 Button、Resource、Empty、Modal、Search、Pager 由 src/components/ui.tsx 拥有。Button 默认白底边框，主要动作枣红，图标按钮有 aria-label；busy 保留按钮尺寸且防重复。导航选中态有文字与底色。列表可点行使用 button；附件仅在可下载时显示下载动作。

Resource 初始加载显示固定高度骨架；成功显示数据，更新时间放入刷新按钮 title；失败保留同账号缓存并提示旧数据；认证失败清除旧内容并提供重新登录。刷新中仅旋转刷新图标。空状态只来自成功空结果，部分失败列出缺失课程。搜索包含清空按钮，中文输入法组合结束再延迟 300ms 请求；换词回到第一页，旧结果不混入新词。

模态框采用 Radix Dialog，焦点锁定、Escape 关闭、关闭后恢复触发焦点。短信表单 noValidate，显式本地校验。二维码过期可以重新生成。下载状态与取消在附件下方显示，不阻断其他操作。

反馈动画 160ms；加载旋转 800ms；prefers-reduced-motion 下取消所有非必要动画。滚动条统一细且随内容出现，支持标准与 WebKit。中文金额显示人民币与两位小数，日期以北京时区显示。提示内容不包含 token、cookie 或原始服务错误 URL。

## Do's and Don'ts

- Do: 每块资源独立刷新、错误局部呈现，其他资源正常使用。
- Do: 用原始课程与课程通知内容，明确未更新的范围。
- Don't: 把网络失败呈现为没有作业或今日无课。
- Don't: 添加营销说明、装饰性大图或不对应真实数据的数字。

## v0.2.1 校园卡与反馈细化

参考用户提供的学校卡面，使用珊瑚红湖景与右侧石雕纹样生成装饰素材，仅放在校园卡面；全局继续白底。金额、状态和有效期用真实文本覆盖，图像不承载私人信息。首页与校园卡页共用 CampusCard。正常状态写“正常”，不重复“校园卡”。移除各处斜向链接箭头，通过明确按钮文案、整行悬停、文字下划线及键盘焦点表达点击。保留分页与展开的方向图标。正常更新时间不常驻显示，刷新按钮悬停可查；来源失败/缓存提示仍可见。
