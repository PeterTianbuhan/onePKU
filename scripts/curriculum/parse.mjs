// 把 pdftotext -layout 输出的培养方案卷文本解析成结构化专业方案。
// 只做确定性的文本解析；解析不了的行进入 warnings，不猜。
// 输出结构见 docs/CURRICULUM-DATA.md。

const NATURES = [
  "全校必修",
  "专业必修",
  "专业选修",
  "专业任选",
  "专业限选",
  "限选",
  "任选",
  "必修",
  "选修",
];
const NATURE_RE = new RegExp(`(?:^|\\s)(${NATURES.join("|")})(?=\\s|$)`);
const CODE_RE = /^\s*(\d{8})\s+(.*)$/;
const CODE_ONLY_RE = /^\s*(\d{8})\s*$/;
const NUMBER_RE = /^\d+(?:\.\d+)?$/;
const CREDITS_RE =
  /[≥≧]?\s*(\d+(?:\.\d+)?)\s*(?:[-–~～]\s*(\d+(?:\.\d+)?))?\s*(学分|门|学时)/;
const SCHOOL_RE =
  /^\s*(北京大学\S+?(?:学院|学部|系|研究院|中心|书院|学堂)(?:\/\S+)?)\s*$/;
const ANCHOR_RE = /^\s*一、/;
const TOP_GROUP_RE =
  /^\s*([123])\s*[.．、](?!\s*\d)\s*([^：:]{1,14}?)\s*(?:要求)?\s*(?:[：:]?\s*(\d[\d.]*\s*(?:[-–~～]\s*\d[\d.]*)?\s*学分.*?))?\s*$/;
const SUB_GROUP_RE =
  /^\s*(\d[.\-]\d(?:[.\-]\d)?)\s*([^：:]{1,24}?)\s*(?:[：:]?\s*([≥≧]?\d[\d.]*\s*(?:[-–~～]\s*\d[\d.]*)?\s*学分.*?|[（(].{1,30}[）)]))?\s*$/;
// 少数院系用中文序号写课程组：（一）公共基础课程 / 一、专业必修课程。
const CN_TOP_GROUP_RE =
  /^\s*[（(]?([一二三])[）)、.．]\s*((?:公共基础|专业必修|选修)课程?)\s*(?:[：:]?\s*(.*学分.*?))?\s*$/;
const CN_NUM = { 一: "1", 二: "2", 三: "3" };
const dotted = (id) => id.replace(/-/g, ".");
const LIST_GROUP_RE = /^\s*[（(](\d{1,2})[）)]\s*(.{1,32}?)\s*[。.]?\s*$/;
const TABLE_HEADER_RE = /课程名称/;
const ALTERNATIVES_RE = /可替代课程列表|替代课程/;
// 课程设置章节的结束标志：后续章节、荣誉学位等以裸编号“1.”另起的段落，或课程地图。
const BODY_END_RE = /^\s*(?:[六七八九十]、|\d[.．、]\s*$|.*课程地图\s*$)/;

// 页眉页脚替换为空行，保持行号与原文本一致，便于对照 PDF 文本排错。
function stripDecorations(lines) {
  return lines.map((raw) => {
    const l = raw.replace(/\f/g, "");
    const decoration =
      /北京大学本科(培养方案|教学计划)[（(]\d{4}[）)]\s*·\s*[理文]科卷/.test(
        l,
      ) ||
      /^\s*·\d+·\s*$/.test(l) ||
      /^\s*北京大学\S+\s+·\d+·\s*$/.test(l) ||
      /^\s*·\d+·\s+北京大学\S+\s*$/.test(l) ||
      /^\s*续表\s*$/.test(l);
    return decoration ? "" : l;
  });
}

function parseCredits(text) {
  const m = text && CREDITS_RE.exec(text);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] ? Number(m[2]) : min;
  return { min, max, unit: m[3] };
}

function splitTitle(title) {
  const parens = [];
  const bare = title
    .replace(/[（(]([^（）()]*)[）)]/g, (_, inner) => {
      parens.push(inner.trim());
      return " ";
    })
    .replace(/专业/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "/");
  return { major: bare, track: parens.length ? parens.join("/") : null };
}

/** 一行里可能作为课程名续写的片段：取首个单元格，必须是不含数字与标点的短中文。 */
function fragmentOf(line) {
  if (!line || !/^\s{4,}\S/.test(line)) return null;
  const cell = line.trim().split(/\s{2,}/)[0];
  if (!cell || cell.length > 24) return null;
  if (
    /\d|[；;，。、]|[：:]$|学分|学时|至少|不少于|选修|必修|课号|课程名称|替代|^注|^要求|^续表/.test(
      cell,
    )
  )
    return null;
  if (/^[（(]\d+[）)]/.test(cell) || /^[一二三四五六七八九十]+、/.test(cell))
    return null;
  if (/^(?:大[一二三四]|[一二三四][上下]|秋季|春季|暑期|全年)/.test(cell))
    return null;
  return cell;
}

function unbalanced(name) {
  let depth = 0;
  for (const ch of name) {
    if (ch === "（" || ch === "(") depth++;
    if (ch === "）" || ch === ")") depth--;
  }
  return depth > 0;
}

function parseRow(rest, mode) {
  const row = {
    name: "",
    nature: null,
    credits: null,
    hours: null,
    practice: null,
    term: null,
  };
  let after = rest;
  let effective = mode;
  if (mode === "normal") {
    const m = NATURE_RE.exec(" " + rest);
    if (m) {
      const idx = m.index;
      row.name = rest.slice(0, Math.max(0, idx)).trim();
      row.nature = m[1];
      after = rest.slice(idx + m[0].length - 1).trim();
    } else {
      effective = "plain";
    }
  }
  if (effective !== "normal") {
    const tokens = rest.trim().split(/\s+/);
    let i = 0;
    // 课程名以数字开头（如“20 世纪俄国文学专题”）时，数字后紧跟中文的仍属课程名。
    while (
      i < tokens.length &&
      (!NUMBER_RE.test(tokens[i]) ||
        (i + 1 < tokens.length &&
          /^[一-鿿]/.test(tokens[i + 1]) &&
          !NATURE_RE.test(" " + tokens[i + 1])))
    )
      i++;
    row.name = tokens.slice(0, i).join(" ");
    after = tokens.slice(i).join(" ");
  }
  const tokens = after ? after.split(/\s+/) : [];
  const numbers = [];
  const words = [];
  for (const t of tokens) (NUMBER_RE.test(t) ? numbers : words).push(t);
  if (numbers.length) row.credits = Number(numbers[0]);
  if (numbers.length > 1) row.hours = Number(numbers[1]);
  if (numbers.length > 2) row.practice = Number(numbers[2]);
  if (words.length) row.term = words.join(" ");
  return row;
}

function parseSection(lines, start, end) {
  const warnings = [];
  const notes = [];
  const section = lines.slice(start, end);
  const lineNo = (i) => start + i + 1;

  // 课程设置正文：从第一个 “x.y” 子标题（可能前面紧跟 “1. 公共基础课程”）开始，
  // 到后续章节、裸编号段落或课程地图结束。不依赖 “四、/五、” 章节标题是否存在。
  let bodyStart = section.findIndex((l) => /^\s*五、\s*课程设置/.test(l));
  // 只用带点的子标题定位正文；“1-1 大学英语：…”这类连字符行也出现在毕业要求汇总表里，不能当起点。
  if (bodyStart < 0)
    bodyStart = section.findIndex(
      (l) => SUB_GROUP_RE.test(l) && /^\s*1\.[12]\b/.test(l),
    );
  if (bodyStart < 0)
    bodyStart = section.findIndex(
      (l) => SUB_GROUP_RE.test(l) && /^\s*\d\.\d/.test(l),
    );
  if (bodyStart < 0) {
    const cn = [];
    section.forEach((l, i) => {
      if (CN_TOP_GROUP_RE.test(l) && /公共基础/.test(l)) cn.push(i);
    });
    if (cn.length) bodyStart = cn.length > 1 ? cn[1] : cn[0];
  }
  if (bodyStart < 0) {
    // 没有子标题的版式（如物理学院）：课程设置从第二次出现的“1. 公共基础课程”开始，
    // 第一次出现在毕业要求汇总表里。
    const tops = [];
    section.forEach((l, i) => {
      if (TOP_GROUP_RE.test(l) && /^\s*1\s*[.．、]/.test(l) && /公共/.test(l))
        tops.push(i);
    });
    bodyStart = tops.length > 1 ? tops[1] : (tops[0] ?? -1);
  }
  if (bodyStart > 0 && !/^\s*五、/.test(section[bodyStart])) {
    let j = bodyStart - 1;
    while (j >= 0 && !section[j].trim()) j--;
    if (j >= 0 && TOP_GROUP_RE.test(section[j]) && /^\s*1/.test(section[j]))
      bodyStart = j;
  }
  let bodyEnd = section.length;
  if (bodyStart >= 0) {
    for (let i = bodyStart + 1; i < section.length; i++) {
      if (
        BODY_END_RE.test(section[i]) &&
        !/^\s*\d[.．、]\s*$/.test(section[i])
      ) {
        bodyEnd = i;
        break;
      }
      if (/^\s*\d[.．、]\s*$/.test(section[i])) {
        bodyEnd = i;
        break;
      }
    }
  }

  if (process.env.CURRICULUM_DEBUG)
    console.error(
      `[debug] section ${lineNo(0)}-${lineNo(section.length - 1)} bodyStart=${bodyStart >= 0 ? lineNo(bodyStart) : -1} bodyEnd=${lineNo(bodyEnd - 1)}`,
    );
  let degree = null;
  let totalCredits = null;
  const requirements = [];
  const topRequirements = [];
  const head = bodyStart >= 0 ? section.slice(0, bodyStart) : section;
  for (const raw of head) {
    const line = raw.replace(/\s+/g, " ");
    const d = /授予学位类型[：:]\s*(\S+)/.exec(line);
    if (d && !degree) degree = d[1].replace(/学位$/, "");
    const t = /毕业总学分[：:]\s*(\d+)(?:\s*[-–~～]\s*(\d+))?/.exec(line);
    if (t && !totalCredits)
      totalCredits = { min: Number(t[1]), max: Number(t[2] ?? t[1]) };
    for (const m of line.matchAll(
      /(?:^|\s)([123])[、.．]\s*([^：:\s]{1,12})\s*[：:]\s*([≥≧]?[\d.]+(?:\s*[-–~～]\s*[\d.]+)?)\s*学分/g,
    ))
      if (!topRequirements.some((r) => r.id === m[1]))
        topRequirements.push({
          id: m[1],
          name: m[2],
          ...parseCredits(m[3] + " 学分"),
        });
    for (const m of line.matchAll(
      /(?:^|\s)([123]-\d{1,2})\s*([^：:\s]{1,16})\s*[：:]\s*([^\s]+(?:\s*[-–~～]\s*[^\s]+)?\s*(?:学分|门|学时))/g,
    )) {
      if (requirements.some((r) => r.id === m[1])) continue;
      const credits = parseCredits(m[3]);
      requirements.push({
        id: m[1],
        parent: m[1][0],
        name: m[2],
        requirement: m[3].trim(),
        ...(credits ?? {}),
      });
    }
    // 2021/2023 卷的汇总表把 “1-1” 排成了 “-1”，父级按名称判断。
    for (const m of line.matchAll(
      /(?:^|\s)-(\d{1,2})\s*([^：:\s]{1,16})\s*[：:]\s*([^\s]+(?:\s*[-–~～]\s*[^\s]+)?\s*(?:学分|门|学时))/g,
    )) {
      const parent = /公共必修|通识|英语|思政|思想|体育|军事|信息|劳动/.test(
        m[2],
      )
        ? "1"
        : /专业基础|专业核心|论文|非课程|实习|实践/.test(m[2])
          ? "2"
          : /选修/.test(m[2])
            ? "3"
            : null;
      if (!parent) continue;
      const id = `${parent}-${m[1]}`;
      if (requirements.some((r) => r.id === id)) continue;
      const credits = parseCredits(m[3]);
      requirements.push({
        id,
        parent,
        name: m[2],
        requirement: m[3].trim(),
        inferredParent: true,
        ...(credits ?? {}),
      });
    }
  }
  if (!totalCredits) {
    const fallback = section
      .map((l) => /总学分\s*[：:]?\s*(\d+)/.exec(l))
      .find(Boolean);
    if (fallback)
      totalCredits = {
        min: Number(fallback[1]),
        max: Number(fallback[1]),
        inferred: true,
      };
    else warnings.push("未找到“毕业总学分”");
  }

  const groups = [];
  const unparsed = [];
  let current = null;
  let mode = "normal";
  let pendingFragment = null;
  let lastRow = null;
  const pushGroup = (g) => {
    groups.push(g);
    current = g;
    mode = "normal";
    pendingFragment = null;
  };
  const nextIndex = (i) => {
    for (let j = i + 1; j < bodyEnd; j++) if (section[j].trim()) return j;
    return -1;
  };

  for (let i = bodyStart >= 0 ? bodyStart : section.length; i < bodyEnd; i++) {
    const line = section[i];
    const t = line.trim();
    if (!t) continue;
    if (TABLE_HEADER_RE.test(t) && /课号|课程号|课程编号/.test(t)) {
      if (ALTERNATIVES_RE.test(t)) mode = "alternatives";
      else if (/课程性质/.test(t)) mode = "normal";
      else if (mode !== "alternatives") mode = "plain";
      pendingFragment = null;
      continue;
    }
    if (/^可替代课程列表/.test(t)) {
      mode = "alternatives";
      pendingFragment = null;
      continue;
    }
    let code = CODE_RE.exec(line);
    if (!code && CODE_ONLY_RE.test(line)) code = [line, line.trim(), ""];
    if (code) {
      if (!current) {
        warnings.push(`第 ${lineNo(i)} 行：课程行出现在任何课程组之前：${t}`);
        continue;
      }
      let rest = code[2];
      let row = parseRow(rest, mode);
      // 课程性质和学分落在下一行时把下一行并进来（长课程名换行的常见版式）。
      if (row.credits === null) {
        const j = nextIndex(i);
        const next = j >= 0 ? section[j] : "";
        if (
          next &&
          !CODE_RE.test(next) &&
          !CODE_ONLY_RE.test(next) &&
          (NATURE_RE.test(" " + next) ||
            /\s\d+(?:\.\d+)?(?:\s|$)/.test(next)) &&
          !TABLE_HEADER_RE.test(next) &&
          !SUB_GROUP_RE.test(next)
        ) {
          rest = `${rest.trim()} ${next.trim()}`;
          const merged = parseRow(rest, mode);
          if (merged.credits !== null) {
            row = merged;
            i = j;
          }
        }
      }
      row.code = code[1];
      let usedPending = false;
      if (
        (!row.name || /^[（(][^（）()]*[）)]$/.test(row.name)) &&
        pendingFragment
      ) {
        row.name = (pendingFragment + row.name).trim();
        usedPending = true;
      }
      pendingFragment = null;
      if (!row.name || usedPending || unbalanced(row.name)) {
        const j = nextIndex(i);
        const frag = j >= 0 ? fragmentOf(section[j]) : null;
        if (frag) {
          row.name = (row.name + frag).trim();
          i = j;
        }
      }
      if (!row.name) {
        warnings.push(
          `第 ${lineNo(i)} 行：课程 ${row.code} 缺少课程名，未纳入`,
        );
        unparsed.push({
          code: row.code,
          line: lineNo(i),
          text: t.slice(0, 60),
        });
        continue;
      }
      if (row.credits === null)
        warnings.push(`第 ${lineNo(i)} 行：课程行缺少学分：${t.slice(0, 40)}`);
      if (mode === "alternatives") {
        const alt = {
          code: row.code,
          name: row.name,
          credits: row.credits,
          replaces: row.term,
        };
        current.alternatives.push(alt);
        lastRow = alt;
      } else {
        current.courses.push(row);
        lastRow = row;
      }
      continue;
    }
    let m;
    if ((m = CN_TOP_GROUP_RE.exec(line))) {
      const id = CN_NUM[m[1]];
      if (groups.some((g) => g.id === id)) {
        warnings.push(
          `第 ${lineNo(i)} 行：课程设置出现第二套“${m[1]}、${m[2]}”，只保留第一套`,
        );
        break;
      }
      pushGroup({
        id,
        parent: null,
        name: m[2],
        ...(parseCredits(m[3]) ?? {}),
        courses: [],
        alternatives: [],
      });
      continue;
    }
    if ((m = TOP_GROUP_RE.exec(line)) && /课|论文|实践|实习/.test(m[2])) {
      // 课程组编号只会递增；再次出现“1.”说明进入了另一套课程设置（如留学生版），只保留第一套。
      if (groups.some((g) => g.id === m[1])) {
        warnings.push(
          `第 ${lineNo(i)} 行：课程设置出现第二套“${m[1]}. ${m[2]}”，只保留第一套`,
        );
        break;
      }
      pushGroup({
        id: m[1],
        parent: null,
        name: m[2],
        ...(parseCredits(m[3]) ?? {}),
        courses: [],
        alternatives: [],
      });
      continue;
    }
    if (
      (m = SUB_GROUP_RE.exec(line)) &&
      !/[。；;]$/.test(t) &&
      !/^\d-\d\s*$/.test(t)
    ) {
      const id = dotted(m[1]);
      if (groups.some((g) => g.id === id)) {
        warnings.push(
          `第 ${lineNo(i)} 行：课程组编号 ${id} 重复出现，之后的内容未纳入`,
        );
        break;
      }
      const remainder = m[3] ?? "";
      const credits = parseCredits(remainder);
      const note = remainder
        .replace(CREDITS_RE, "")
        .replace(/^[（(]|[）)]$/g, "")
        .trim();
      pushGroup({
        id,
        parent: id.split(".").slice(0, -1).join("."),
        name: m[2],
        ...(credits ?? {}),
        note: note || undefined,
        courses: [],
        alternatives: [],
      });
      continue;
    }
    const listLike =
      (m = LIST_GROUP_RE.exec(line)) &&
      !/[；;，]/.test(t) &&
      !/建议|原则|不允许|不计入|详见|需通过|补齐|免修|不能|同名|互斥|以上|以下/.test(
        t,
      ) &&
      current;
    const nextIsTable = () => {
      const j = nextIndex(i);
      return (
        j >= 0 &&
        TABLE_HEADER_RE.test(section[j]) &&
        /课号|课程号/.test(section[j])
      );
    };
    if (listLike && (/学分|至少|不少于/.test(t) || nextIsTable())) {
      const parent = current.kind === "list" ? current.parent : current.id;
      const credits = parseCredits(m[2]);
      const name = m[2]
        .replace(/[（(][^（）()]*[）)]\s*$/, "")
        .replace(/[：:]\s*$/, "")
        .trim();
      let id = `${parent}-${m[1]}`;
      if (groups.some((g) => g.id === id)) id = `${id}-${groups.length}`;
      pushGroup({
        id,
        parent,
        kind: "list",
        name: name || m[2],
        ...(credits ?? {}),
        requirement: m[2],
        courses: [],
        alternatives: [],
      });
      continue;
    }
    if (/^注[：:]/.test(t) || /^[（(]\d+[）)]/.test(t) || /^要求/.test(t)) {
      notes.push(t);
      continue;
    }
    const frag = fragmentOf(line);
    if (frag && lastRow && current) {
      const j = nextIndex(i);
      const next = j >= 0 ? section[j] : "";
      const nextCode =
        CODE_RE.exec(next) ||
        (CODE_ONLY_RE.test(next) ? [next, next.trim(), ""] : null);
      if (nextCode && !parseRow(nextCode[2], mode).name) pendingFragment = frag;
      else if (
        unbalanced(lastRow.name) ||
        (mode !== "alternatives" && !lastRow.term && lastRow.credits === null)
      )
        lastRow.name = (lastRow.name + frag).trim();
      else if (nextCode) pendingFragment = frag;
      else notes.push(t);
      continue;
    }
    if (t.length > 30 || /[。；]$/.test(t)) notes.push(t);
  }

  return {
    degree,
    totalCredits,
    topRequirements,
    requirements,
    groups,
    unparsed,
    notes,
    warnings,
  };
}

export function parseVolume(text, meta) {
  const rawLines = text.split(/\r?\n/);
  // pdftotext 在每页开头放一个换页符；据此得到每行所在的 PDF 页码（从 1 起）。
  const pageOfLine = [];
  let page = 1;
  for (const l of rawLines) {
    page += (l.match(/\f/g) ?? []).length;
    pageOfLine.push(page);
  }
  // 页脚里印刷的页码（·445·），与 PDF 页码有前置页的偏移，给用户对照原书用。
  const printedLabels = (from, to) => {
    let first = null;
    let last = null;
    for (let i = from; i < to; i++) {
      const m = /·(\d+)·/.exec(rawLines[i]);
      if (!m) continue;
      const n = Number(m[1]);
      if (first === null) first = n;
      last = n;
    }
    return first === null ? null : [first, last];
  };
  const lines = stripDecorations(rawLines);
  // 两类段首：“一、…”章节行（往上找院系行与标题），以及紧跟标题却没有“一、”的院系行
  // （个别专业直接从“1. 专业历史沿革”开始）。
  const heads = [];
  const covered = new Set();
  for (let a = 0; a < lines.length; a++) {
    if (!ANCHOR_RE.test(lines[a])) continue;
    let schoolIdx = -1;
    for (let j = a - 1; j >= 0 && a - j <= 12; j--) {
      if (!lines[j].trim()) continue;
      if (SCHOOL_RE.test(lines[j])) {
        schoolIdx = j;
        break;
      }
    }
    const titleIdx = [];
    const from = schoolIdx >= 0 ? schoolIdx + 1 : Math.max(0, a - 6);
    for (let j = a - 1; j >= from; j--) {
      const t = lines[j].trim();
      if (!t) continue;
      if (
        schoolIdx < 0 &&
        (t.length > 30 ||
          /[。；：:]$/.test(t) ||
          /^[一二三四五六七八九十]+、|^\d+[.．、]|^[（(]\d+[）)]|课程地图/.test(
            t,
          ))
      )
        break;
      titleIdx.unshift(j);
    }
    heads.push({ anchor: a, schoolIdx, titleIdx });
    if (schoolIdx >= 0) covered.add(schoolIdx);
  }
  for (let s = 0; s < lines.length; s++) {
    if (covered.has(s) || !SCHOOL_RE.test(lines[s])) continue;
    const titleIdx = [];
    let j = s + 1;
    let seen = 0;
    while (j < lines.length && seen < 6 && titleIdx.length < 3) {
      const t = lines[j].trim();
      if (t) {
        seen++;
        if (
          t.length <= 30 &&
          !/[。；：:，、]$/.test(t) &&
          /专业|方向|班|项目|学位|学$/.test(t) &&
          !/^[一二三四五六七八九十]+、|^\d+[.．、]|^[（(]\d+[）)]/.test(t)
        )
          titleIdx.push(j);
        else break;
      }
      j++;
    }
    if (titleIdx.length) {
      const anchor = titleIdx[titleIdx.length - 1] + 1;
      // 只有后面紧接章节内容（“1. 专业历史沿革”或“二、培养目标”）时才算一份方案的开头。
      const follow = lines
        .slice(anchor, anchor + 8)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");
      if (/^\s*(?:1[.．、]\s*专业|二、|1[.．、]\s*培养)/.test(follow))
        heads.push({ anchor, schoolIdx: s, titleIdx });
      continue;
    }
    // 标题与章节标题都没被提取出来的版式（2024 卷的标题字体无法抽取）：院系行后直接是正文。
    // 这类段落到下一个院系行之间若有“毕业总学分”，就当作一份没有标题的方案，标题稍后推断。
    let e = s + 1;
    while (e < lines.length && !SCHOOL_RE.test(lines[e])) e++;
    const body = lines.slice(s + 1, e);
    if (
      body.some((l) => /毕业总学分/.test(l)) &&
      !heads.some(
        (h) =>
          (h.schoolIdx >= 0 ? h.schoolIdx : h.anchor) > s &&
          (h.schoolIdx >= 0 ? h.schoolIdx : h.anchor) < e,
      )
    ) {
      heads.push({ anchor: s + 1, schoolIdx: s, titleIdx: [], untitled: true });
    }
  }
  heads.sort(
    (x, y) =>
      (x.schoolIdx >= 0 ? x.schoolIdx : (x.titleIdx[0] ?? x.anchor)) -
      (y.schoolIdx >= 0 ? y.schoolIdx : (y.titleIdx[0] ?? y.anchor)),
  );
  const plans = [];
  const volumeWarnings = [];
  let lastSchool = null;
  heads.forEach((h, k) => {
    const start = h.schoolIdx >= 0 ? h.schoolIdx : (h.titleIdx[0] ?? h.anchor);
    const nextHead = heads[k + 1];
    const end = nextHead
      ? nextHead.schoolIdx >= 0
        ? nextHead.schoolIdx
        : (nextHead.titleIdx[0] ?? nextHead.anchor)
      : lines.length;
    let school =
      h.schoolIdx >= 0
        ? lines[h.schoolIdx].trim().replace(/^北京大学/, "")
        : null;
    const qualifiers = [];
    const titleParts = [];
    for (const idx of h.titleIdx) {
      const t = lines[idx].trim();
      if (/^[（(].*[）)]$/.test(t) && /适用|仅|限|不含|除/.test(t))
        qualifiers.push(t.replace(/^[（(]|[）)]$/g, ""));
      else titleParts.push(t);
    }
    const title = titleParts
      .join(" ")
      .replace(/(?<=[一-鿿（）+])\s+(?=[一-鿿（）+])/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const section = parseSection(lines, start, end);
    const courseCount = section.groups.reduce(
      (n, g) => n + g.courses.length,
      0,
    );
    const isPlan = h.untitled
      ? Boolean(section.totalCredits && courseCount >= 5)
      : title.length <= 40 &&
        /专业|方向|班|项目|学位/.test(title) &&
        (section.totalCredits || section.degree || courseCount >= 5);
    if (!isPlan) {
      if (section.totalCredits || courseCount >= 5)
        volumeWarnings.push(
          `跳过第 ${h.anchor + 1} 行附近的“${(title || "(无标题)").slice(0, 40)}”：标题不像专业方案`,
        );
      return;
    }
    if (!school) {
      school = lastSchool;
      section.warnings.push("院系名沿用上一份方案，请核对");
    }
    lastSchool = school;
    const { major, track } = splitTitle(title);
    if (h.untitled) section.warnings.push("原文标题无法提取，专业名待推断");
    const id = h.untitled
      ? `${meta.cohort}-${school ?? "未知院系"}-未命名${plans.length + 1}`
      : [meta.cohort, school ?? "未知院系", major, track]
          .filter(Boolean)
          .join("-")
          .replace(/[\/\s]+/g, "_");
    plans.push({
      id,
      untitled: h.untitled || undefined,
      cohort: meta.cohort,
      volume: meta.title,
      school,
      major,
      track,
      title,
      kind: /项目$/.test(title) ? "project" : "major",
      qualifiers,
      ...section,
      source: {
        volumeId: meta.id,
        url: meta.url,
        lineStart: start + 1,
        lineEnd: end,
        pageStart: pageOfLine[start],
        pageEnd: pageOfLine[Math.max(start, end - 1)],
        pageLabels: printedLabels(start, end),
      },
    });
  });
  const ids = new Map();
  for (const p of plans) {
    const n = (ids.get(p.id) ?? 0) + 1;
    ids.set(p.id, n);
    if (n > 1) p.id = `${p.id}-${n}`;
  }
  return { plans, warnings: volumeWarnings };
}
