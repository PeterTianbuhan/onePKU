// 演示数据：`npm run demo` 时由 Vite 接住 /api，全部返回虚构内容。
// 改界面、截图都用它，不碰真实账号，也不会把真实成绩或余额带进仓库。
const DAY = 24 * 60 * 60 * 1000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
const day = (offset) =>
  new Date(Date.now() + offset * DAY).toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
  });
const month = () => day(0).slice(0, 7);

const courses = [
  ["c1", "算法设计与分析", "25-26学年第1学期", true],
  ["c2", "计算机系统导论", "25-26学年第1学期", true],
  ["c3", "信息学中的概率统计", "25-26学年第1学期", true],
  ["c4", "中国近现代史纲要", "25-26学年第1学期", true],
  ["c5", "大学英语（四）", "25-26学年第1学期", true],
  ["c6", "太极拳", "25-26学年第1学期", true],
  ["b1", "数据结构与算法（A）", "24-25学年第2学期", false],
  ["b2", "高等数学 A（二）", "24-25学年第2学期", false],
  ["b3", "线性代数 A（Ⅱ）", "24-25学年第2学期", false],
  ["b4", "人工智能引论", "24-25学年第2学期", false],
  ["a1", "计算概论 A", "24-25学年第1学期", false],
  ["a2", "高等数学 A（一）", "24-25学年第1学期", false],
  ["a3", "线性代数 A（Ⅰ）", "24-25学年第1学期", false],
].map(([id, name, semester, current]) => ({ id, name, semester, current }));

const assignment = (n, course, title, deadline, extra = {}) => ({
  hash_id: `hw${n}`,
  course_id: course,
  course_name: courses.find((c) => c.id === course).name,
  content_id: `content${n}`,
  title,
  deadline_raw: null,
  deadline: deadline === null ? null : iso(deadline),
  last_attempt: null,
  score: null,
  detail_error: false,
  descriptions: [
    "请独立完成，书写清晰。提交一份 PDF，文件名为「学号-姓名」。",
    "迟交每天扣 10%，三天后不再接收。",
  ],
  attachments: [{ name: `${title}.pdf`, downloadId: `file${n}` }],
  ...extra,
});
const assignments = () => [
  assignment(1, "c1", "第七次作业：动态规划", 9 * 60 * 60 * 1000),
  assignment(2, "c2", "Attack Lab", 2.4 * DAY),
  assignment(3, "c3", "习题六：大数定律与中心极限定理", 4.2 * DAY),
  assignment(4, "c4", "读书报告：《天朝的崩溃》", 12 * DAY),
  assignment(5, "c5", "Unit 5 课堂展示提纲", null),
  assignment(6, "c1", "第六次作业：贪心算法", -3 * DAY, {
    last_attempt: iso(-4 * DAY),
    score: "9.5",
  }),
  assignment(7, "c2", "Bomb Lab", -9 * DAY, {
    last_attempt: iso(-10 * DAY),
    score: "70",
  }),
  assignment(8, "c3", "习题五：多维随机变量", -6 * DAY, {
    last_attempt: iso(-6.5 * DAY),
  }),
  assignment(9, "c5", "Unit 4 听力练习", -2 * DAY),
];

const notices = () =>
  [
    [
      "c1",
      "期中考试安排",
      0,
      "期中考试定于下周三晚 18:40–20:30，地点理教 107。范围到网络流之前，可带一张 A4 手写纸。",
    ],
    [
      "c2",
      "Attack Lab 截止时间顺延",
      -1,
      "因评测机维护，Attack Lab 截止时间顺延 24 小时。已提交的同学无需重交。",
    ],
    ["c3", "第九周习题课调整", -2, "本周习题课改到周四 5–6 节，教室不变。"],
    ["c4", "读书报告要求", -5, "报告 3000 字左右，注明引文出处。"],
  ].map(([course, title, offset, body], i) => ({
    course_id: course,
    course_name: courses.find((c) => c.id === course).name,
    announcement: {
      id: `n${i}`,
      title,
      body: `<p>${body}</p><p>有问题请在答疑时间来找助教。</p>`,
      date: day(offset),
      author: "课程助教",
    },
  }));

const feeds = {
  school: [
    ["关于 2026 年元旦放假安排的通知", -1, "党政办公室"],
    ["冬季供暖期间教学楼开放时间调整", -3, "总务部"],
    ["校园网出口带宽升级公告", -6, "计算中心"],
  ],
  department: [
    ["未名湖冰场开放时间及安全须知", -2, "保卫部"],
    ["第三十四届「挑战杯」报名启动", -4, "团委"],
  ],
  college: [
    ["本科生科研项目中期检查安排", -1, "信息科学技术学院"],
    ["图灵班学术沙龙第 12 期", -5, "信息科学技术学院"],
  ],
  dean: [
    ["2026 年春季学期选课时间安排", 0, "教务部"],
    ["关于期末考试缓考申请的说明", -7, "教务部"],
  ],
  library: [],
};

const scoreRows = [
  ["算法设计与分析", "5", "", "专业必修", "25-26", "1", "04833040"],
  ["数据结构与算法（A）", "3", "91", "全校必修", "24-25", "2", "04830050"],
  ["高等数学 A（二）", "5", "88", "专业必修", "24-25", "2", "00132512"],
  ["线性代数 A（Ⅱ）", "4", "93", "专业必修", "24-25", "2", "00132324"],
  ["人工智能引论", "3", "86.5", "专业必修", "24-25", "2", "04834490"],
  ["思想道德与法治", "3", "合格", "全校必修", "24-25", "2", "04031740"],
  ["乒乓球", "1", "92", "体育", "24-25", "2", "60730020"],
  ["计算概论 A", "3", "95", "全校必修", "24-25", "1", "04830041"],
  ["高等数学 A（一）", "5", "84", "专业必修", "24-25", "1", "00132511"],
  ["线性代数 A（Ⅰ）", "4", "90", "专业必修", "24-25", "1", "00132323"],
  ["大学英语（三）", "2", "87", "大学英语", "24-25", "1", "03835061"],
  ["音乐与数学", "2", "89", "通选课", "24-25", "1", "01139630"],
].map(([kcmc, xf, xqcj, kclbmc, xnd, xq, kch]) => ({
  kcmc,
  xf,
  xqcj,
  kclbmc,
  xnd,
  xq,
  kch,
}));

const rooms = () =>
  Array.from({ length: 14 }, (_, i) => ({
    room: `${101 + Math.floor(i / 4) * 100 + (i % 4)}`,
    capacity: `${[60, 120, 80, 200][i % 4]}`,
    occupied: Array.from(
      { length: 12 },
      (_, slot) => (i * 7 + slot * 5 + (slot >> 1)) % 5 < 2,
    ),
  }));

const transactions = () => ({
  pages: 3,
  total: 42,
  records: [
    ["学一食堂-电子账户消费", -1250, "consume"],
    ["农园食堂-电子账户消费", -1680, "consume"],
    ["浴室-电子账户消费", -300, "consume"],
    ["微信充值", 20000, "recharge"],
    ["燕南美食-电子账户消费", -2200, "consume"],
    ["图书馆打印-电子账户消费", -150, "consume"],
    ["学五食堂-电子账户消费", -950, "consume"],
    ["松林包子-电子账户消费", -600, "consume"],
  ].map(([resume, tranamt, icon], i) => ({
    resume,
    tranamt,
    icon,
    turnoverType: icon === "recharge" ? "充值" : "消费",
    cardBalance: 21625 + i * 1375,
    effectdateStr: `${day(-Math.floor(i / 2))} ${String(18 - i).padStart(2, "0")}:2${i}:07`,
  })),
});

const daily = () =>
  Object.fromEntries(
    Array.from({ length: Number(day(0).slice(8)) }, (_, i) => [
      `${month()}-${String(i + 1).padStart(2, "0")}`,
      [3250, 2880, 4410, 1900, 0, 5120, 3660, 2540][(i * 3) % 8],
    ]),
  );

// 一页空白 A4 横版 PDF：校历页只需要一份能渲染的文件。
const blankPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 842 595]>>endobj\ntrailer<</Root 1 0 R>>\n",
).toString("base64");

let profile = {
  cohort: 2024,
  planId: "2024-信息科学技术学院-计算机科学与技术",
  secondaryPlanId: null,
  englishLevel: null,
  overrides: {},
  directions: {},
  manualCredits: {},
  draft: [],
  inferred: false,
  updatedAt: "2026-09-01T00:00:00Z",
};
let gradesScope = { included: [], excluded: [] };
const preferences = {
  keepAlive: true,
  downloadRoot: "/Users/demo/Downloads/OnePKU",
  downloadRootIsDefault: true,
  cacheRoot: "/Users/demo/Library/Caches/OnePKU",
  cacheRootIsDefault: true,
};

function answer(r) {
  switch (r.kind) {
    case "snapshot":
      return [];
    case "sessions":
      return ["course", "treehole", "campuscard", "portal"].map((service) => ({
        service,
        state: "verified",
        generation: "demo",
        verifiedAt: iso(-2 * 60 * 60 * 1000),
      }));
    case "profile":
      return profile;
    case "setProfile":
      profile = { ...r.profile, updatedAt: iso(0) };
      return profile;
    case "assignments":
      return assignments();
    case "courseAssignments":
      return assignments().filter((a) => a.course_id === r.course);
    case "assignmentFeedback":
      return {
        url: "",
        attempts:
          r.content === "content6"
            ? [
                {
                  id: "1",
                  label: "第 1 次提交",
                  score: "9.5",
                  pointsPossible: "10",
                  feedback: "第三题的贪心选择性质没有证明，其余很好。",
                  files: [{ name: "作业六.pdf" }],
                  feedbackLinks: [],
                  url: "",
                  unavailable: false,
                },
              ]
            : [],
      };
    case "allCourses":
      return courses;
    case "notices":
      return notices();
    case "courseNotices":
      return notices().filter((n) => n.course_id === r.course);
    case "news":
      return {
        hasMore: false,
        items: (feeds[r.source] ?? []).map(
          ([title, offset, department], i) => ({
            id: `${r.source}-${i}`,
            title,
            date: day(offset),
            source: r.source,
            department,
            url: "https://www.pku.edu.cn/",
          }),
        ),
      };
    case "departments":
      return {
        selected: "",
        detected: "信息科学技术学院",
        effective: "信息科学技术学院",
        source: "portal",
        options: ["信息科学技术学院", "数学科学学院", "物理学院"],
      };
    case "card":
      return [
        {
          name: "演示同学",
          balance: 21625,
          lost: false,
          frozen: false,
          expires: "20280715",
        },
      ];
    case "transactions":
      return transactions();
    case "cardStats":
      return r.part === "total"
        ? { income: 20000, expenses: 68340 }
        : r.part === "daily"
          ? daily()
          : [
              { turnoverType: "餐饮", amount: 52160 },
              { turnoverType: "超市", amount: 9830 },
              { turnoverType: "洗浴", amount: 3900 },
              { turnoverType: "打印", amount: 2450 },
            ];
    case "rooms":
      return rooms();
    case "scores":
      return {
        courses: scoreRows,
        semester_gpas: [
          { xndxq: "24-25-2", gpa: "3.78" },
          { xndxq: "24-25-1", gpa: "3.71" },
        ],
        overall_gpa: "3.75",
        total_credits: "35",
      };
    case "gradesScope":
      return gradesScope;
    case "setGradesScope":
      gradesScope = r.scope;
      return gradesScope;
    case "learningGrades":
      return [
        ["第六次作业", "作业", "9.5 / 10"],
        ["第五次作业", "作业", "10 / 10"],
        ["期中考试", "考试", "—"],
      ].map(([title, category, score], i) => ({
        id: `g${i}`,
        title,
        category,
        score,
        activity: "已评分",
        updated: day(-i * 7),
        status: "",
      }));
    case "content":
      return [
        ["第 9 讲 动态规划（一）", "课件"],
        ["第 8 讲 贪心算法", "课件"],
        ["第 7 讲 分治与递归式", "课件"],
      ].map(([title, type], i) => ({
        id: `m${i}`,
        title,
        item_type: type,
        description: "",
        attachments: [{ name: `${title}.pdf`, downloadId: `m${i}` }],
      }));
    case "localMaterials":
      return [
        {
          id: "l1",
          name: "第 8 讲 贪心算法.pdf",
          bytes: 2_480_000,
          modified: Date.now() / 1000 - 5 * 86400,
          source: "course",
          downloadId: "m1",
        },
      ];
    case "courseVideos":
    case "videos":
      return [0, 2, 7, 9, 14].map((offset, i) => ({
        title: `${day(-offset)}第${3 + (i % 2) * 2}-${4 + (i % 2) * 2}节`,
        time: `${day(-offset)} 10:10`,
        url: "",
        hash_id: `v${i}`,
        room: "理教 107",
      }));
    case "calendarPdf":
      return { year: r.year, pdf: blankPdf, url: "https://www.pku.edu.cn/" };
    case "downloads":
      return [
        {
          id: "d1",
          name: "第 8 讲 贪心算法.pdf",
          state: "done",
          path: "下载/OnePKU/25-26学年第1学期/算法设计与分析",
        },
      ];
    case "preferences":
      return preferences;
    case "setKeepAlive":
      preferences.keepAlive = r.enabled;
      return preferences;
    case "haoxueStatus":
      return { connected: true, name: "演示同学", account: "2400010000" };
    case "credentials":
      return { stored: true, username: "2400010000", otpStored: false };
    case "portalStatus":
      return {
        connected: true,
        name: "演示同学",
        department: "信息科学技术学院",
      };
    case "subtitleSettings":
      return {
        model: "small",
        models: [
          { id: "small", label: "标准", hint: "速度与准确率均衡" },
          { id: "large", label: "精确", hint: "更慢，专有名词更准" },
        ],
        available: true,
        custom: false,
      };
    case "writeOperations":
      return [];
    case "progressStatus":
      return { enabled: false };
    default:
      return undefined;
  }
}

export default function demoApi() {
  return {
    name: "onepku-demo-api",
    configureServer(server) {
      server.middlewares.use("/api", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const request = JSON.parse(body || "{}");
          const data = answer(request);
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              data: data ?? null,
              updatedAt: iso(-3 * 60 * 1000),
              stale: false,
              error:
                data === undefined
                  ? { code: "demo", message: "演示数据里没有这一项" }
                  : null,
              warnings: [],
              generation: "demo",
            }),
          );
        });
      });
    },
  };
}
