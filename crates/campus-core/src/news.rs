//! PKU portal/dean request contracts adapted from ha0xin/pku-coe-notice-helper
//! (MIT). See docs/licenses. EECS selectors verified against the official site;
//! RSSHub's PKU route catalogue supplied source discovery, not copied code.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use scraper::{Html, Selector};

fn home(source: &str) -> Result<&'static str> {
    Ok(match source {
        "school" | "department" | "college" => "https://portal.pku.edu.cn/portal2017/",
        "dean" => "https://dean.pku.edu.cn/web/notice.php",
        "eecs" => "https://eecs.pku.edu.cn/tzgg.htm",
        "library" => "https://www.lib.pku.edu.cn/hdrl/index.htm",
        _ => bail!("invalid news source"),
    })
}
pub(crate) fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(22))
        .user_agent("OnePKU/0.2 (personal campus reader)")
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() < 5 && school_url(a.url().as_str()) {
                a.follow()
            } else {
                a.stop()
            }
        }))
        .build()?)
}
fn school_url(s: &str) -> bool {
    url::Url::parse(s).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && u.host_str()
                .is_some_and(|h| h == "pku.edu.cn" || h.ends_with(".pku.edu.cn"))
    })
}
pub(crate) async fn body(r: reqwest::Response, max: usize) -> Result<Vec<u8>> {
    let r = r.error_for_status()?;
    if !school_url(r.url().as_str()) {
        bail!("invalid response origin")
    }
    if r.content_length().is_some_and(|n| n > max as u64) {
        bail!("response too large")
    }
    let mut stream = r.bytes_stream();
    let mut bytes = vec![];
    use futures::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > max {
            bail!("response too large")
        };
        bytes.extend(chunk);
    }
    Ok(bytes)
}
fn selector(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}
fn text_of(el: scraper::ElementRef<'_>) -> String {
    el.text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn item_id(source: &str, url: &str) -> String {
    format!("{}-{:x}", source, Sha256::digest(url))
}
/// 学院官网目录，与安卓端 `assets/schools.json` 同一份数据。
const DEPARTMENTS: &str = include_str!("../../../data/departments.json");
/// 各校 CMS 模板不一，按「详情链接 + 附近日期」通用提取，规则与安卓端一致。
const DETAIL_PATH: &str = r"/(info|content|notice|news|tzgg|xwgg|art)/|/\d{5,}\.s?html?$|\d{3,}\.s?html?$";
const DATE_NEAR: &str = r"(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})";
const LEADING_DATE: &str = r"^(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s*[:：]?\s*)+";
const PKU_HOST: &str = r"(pku|bjmu|pkusz)\.edu\.cn$";
fn department_list() -> Vec<String> {
    let Ok(table) = serde_json::from_str::<serde_json::Map<String, Value>>(DEPARTMENTS) else {
        return vec![];
    };
    let mut names: Vec<String> = table.keys().cloned().collect();
    names.sort();
    names
}
/// 「生命科学学院」与「生命学院」这类同院异写按词根匹配。
fn core_of(name: &str) -> String {
    let mut value = name.trim().to_string();
    for suffix in ["学院", "大学", "系", "研究所"] {
        if let Some(stripped) = value.strip_suffix(suffix) {
            value = stripped.to_string();
            break;
        }
    }
    value
}
/// 官网表里的手动选择优先精确名，其次补全「学院」，最后才按词根互相包含。
fn resolve_department(department: &str) -> Option<(String, Option<String>)> {
    let Ok(table) = serde_json::from_str::<serde_json::Map<String, Value>>(DEPARTMENTS) else {
        return None;
    };
    let wanted = department.trim();
    if wanted.is_empty() {
        return None;
    }
    let site = |name: &str| {
        table.get(name).map(|entry| {
            (
                name.to_string(),
                entry
                    .get("notice")
                    .and_then(Value::as_str)
                    .filter(|url| !url.is_empty())
                    .map(str::to_string),
            )
        })
    };
    if let Some(found) = site(wanted) {
        return Some(found);
    }
    let suffixed = format!("{}学院", core_of(wanted));
    if let Some(found) = site(&suffixed) {
        return Some(found);
    }
    let want = core_of(wanted);
    if want.chars().count() < 2 {
        return None;
    }
    table.keys().find_map(|name| {
        let have = core_of(name);
        (have.chars().count() >= 2
            && (have.starts_with(&want) || want.starts_with(&have)))
            .then(|| site(name))?
    })
}
/// 学院站点基本都提供 HTTPS，只在校园域内升级，其余保持原样并由来源校验把关。
fn upgrade_http(url: &str) -> String {
    let Some(rest) = url.strip_prefix("http://") else {
        return url.to_string();
    };
    let host = rest.split(['/']).next().unwrap_or_default().split(':').next().unwrap_or_default();
    regex::Regex::new(PKU_HOST)
        .ok()
        .is_some_and(|pattern| pattern.is_match(host))
        .then(|| format!("https://{rest}"))
        .unwrap_or_else(|| url.to_string())
}
/// 取链接上方最多三层文本里的日期，这是各校列表最常见的排版。
fn date_near(anchor: scraper::ElementRef, pattern: &regex::Regex) -> Option<String> {
    let mut node = anchor.parent()?;
    for _ in 0..3 {
        let Some(element) = scraper::ElementRef::wrap(node) else {
            return None;
        };
        let text = element.text().collect::<Vec<_>>().join(" ");
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(captures) = pattern.captures(&text) {
            let year: i32 = captures.get(1)?.as_str().parse().ok()?;
            let month: u32 = captures.get(2)?.as_str().parse().ok()?;
            let day: u32 = captures.get(3)?.as_str().parse().ok()?;
            if (1..=12).contains(&month) && (1..=31).contains(&day) {
                return Some(format!("{year:04}-{month:02}-{day:02}"));
            }
        }
        node = element.parent()?;
    }
    None
}
/// 列表页解析：同域名、像详情页的链接、标题够长、附近找得到日期。
fn parse_site(html: &str, list_url: &str) -> Vec<Value> {
    let Ok(base) = url::Url::parse(list_url) else {
        return vec![];
    };
    let (Ok(detail), Ok(date), Ok(leading), Ok(whitespace)) = (
        regex::Regex::new(DETAIL_PATH),
        regex::Regex::new(DATE_NEAR),
        regex::Regex::new(LEADING_DATE),
        regex::Regex::new(r"\s+"),
    ) else {
        return vec![];
    };
    let dom = Html::parse_document(html);
    let (Ok(anchors), Ok(headings)) = (
        Selector::parse("a[href]"),
        Selector::parse("h4, h3, .tit, .l2"),
    ) else {
        return vec![];
    };
    let mut items: Vec<Value> = vec![];
    let mut titles = std::collections::HashSet::new();
    let mut links = std::collections::HashSet::new();
    for anchor in dom.select(&anchors) {
        let Some(href) = anchor.value().attr("href") else {
            continue;
        };
        let Ok(joined) = base.join(href) else { continue };
        let host = joined.host_str().unwrap_or_default();
        if host != base.host_str().unwrap_or_default() {
            continue;
        }
        if !detail.is_match(joined.path()) {
            continue;
        }
        // 标题优先取链接的 title 属性，其次行内的标题元素，最后才是链接文字。
        let heading = anchor
            .value()
            .attr("title")
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
            .or_else(|| anchor.select(&headings).next().map(text_of))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| text_of(anchor));
        let stripped = leading.replace_all(&heading, "");
        let title = whitespace
            .replace_all(stripped.as_ref(), " ")
            .trim()
            .to_string();
        if title.chars().count() < 6 {
            continue;
        }
        let Some(date) = date_near(anchor, &date) else {
            continue;
        };
        // 同一则通知常有「标题 + 更多」多个链接，也可能整页重复渲染。
        if !titles.insert(title.clone()) || !links.insert(joined.as_str().to_string()) {
            continue;
        }
        items.push(json!({
            "id": item_id("college", joined.as_str()),
            "title": title.chars().take(120).collect::<String>(),
            "date": date,
            "department": "",
            "source": "college",
            "detail": "site",
            "url": joined.as_str(),
        }));
    }
    items.sort_by(|a, b| b["date"].as_str().unwrap_or("").cmp(a["date"].as_str().unwrap_or("")));
    items.truncate(25);
    items
}
/// 门户接口不支持按院系查询，只能翻最近若干页再本地匹配。
async fn portal_for_department(core: &str) -> Result<Vec<Value>> {
    let c = client()?;
    let mut collected: Vec<Value> = vec![];
    let mut seen = std::collections::HashSet::new();
    for page in 1..=10u32 {
        let (rows, _) = portal_rows(&c, "retrAllDeptNotice.do", page).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let department = row["Department"].as_str().unwrap_or_default();
            if core.chars().count() < 2 || !department.contains(core) {
                continue;
            }
            let id = row["Number"].as_str().unwrap_or_default();
            if id.is_empty() || !seen.insert(id.to_string()) {
                continue;
            }
            collected.push(json!({
                "id": id,
                "title": row["Title"],
                "date": row["Time"],
                "department": department,
                "source": "college",
                "detail": "portal",
                "url": format!("https://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/{id}"),
            }));
        }
        if collected.len() >= 15 {
            break;
        }
    }
    collected.sort_by(|a, b| b["date"].as_str().unwrap_or("").cmp(a["date"].as_str().unwrap_or("")));
    collected.truncate(25);
    Ok(collected)
}
async fn portal_rows(
    c: &reqwest::Client,
    endpoint: &str,
    page: u32,
) -> Result<(Vec<Value>, Value)> {
    let bytes = body(
        c.post(format!(
            "https://portal.pku.edu.cn/portal2017/notice/{endpoint}"
        ))
        .form(&[
            ("keyword", "ALL".to_string()),
            ("limit", "20".into()),
            ("start", ((page - 1) * 20).to_string()),
        ])
        .send()
        .await?,
        2 * 1024 * 1024,
    )
    .await?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if value["success"] != true {
        bail!("学校通知服务未返回数据")
    }
    Ok((
        value["rows"]
            .as_array()
            .cloned()
            .ok_or_else(|| anyhow!("通知数据格式变化"))?,
        value["results"].clone(),
    ))
}
/// 本院按哪个院系读：手动选择优先，其次才是校内门户识别到的单位。
pub(crate) fn department_effective() -> (String, &'static str) {
    let prefs = super::maintenance::read_preferences();
    let manual = prefs
        .get("department")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !manual.is_empty() {
        return (manual, "手动选择");
    }
    let detected = prefs
        .get("departmentDetected")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !detected.is_empty() {
        return (detected, "校内门户");
    }
    (String::new(), "")
}
pub(crate) fn department_setting() -> Result<String> {
    let (department, _) = department_effective();
    if department.is_empty() {
        bail!("请先在设置里连接校内门户识别院系，或手动选择本院");
    }
    Ok(department)
}
/// 校内门户连接状态：能读到基本资料才算连着，识别到的院系只作兜底。
pub(crate) async fn portal_status() -> Result<Value> {
    // 与安卓端同一口径：连接状态看本机存的会话，不拿它去联网探测。
    // 探测会把「学校会话过期」显示成「没连接」，用户明明能识别学院却被告知未连。
    let store = Store::new("portal")?;
    match store.load_session()? {
        Some(session) => Ok(json!({
            "connected": true,
            "name": session.extra.get("name").and_then(Value::as_str).unwrap_or_default(),
            "department": session.extra.get("department").and_then(Value::as_str).unwrap_or_default(),
        })),
        None => Ok(json!({ "connected": false, "name": "", "department": "" })),
    }
}
/// 读一次门户「单位」并记下来，供本院通知与培养方案推断使用。
pub(crate) async fn portal_detect() -> Result<Value> {
    let store = Store::new("portal")?;
    let info = pku_portal::login::basic_info(&store).await?;
    let department = pku_portal::login::department_of(&info);
    if department.is_empty() {
        bail!("门户没有返回院系信息，请在设置里手动选择本院");
    }
    // 识别成功就说明门户 cookie 是活的：顺手把会话补上，卡片才会显示已连接。
    // 旧版本登录时只存了 cookie，没存会话，状态就一直停在未连接。
    if store.load_session()?.is_none() {
        let mut session = pkuinfo_common::session::Session::new(String::new());
        session.extra = json!({
            "department": department,
            "name": pku_portal::login::name_of(&info),
        });
        store.save_session(&session)?;
    }
    super::maintenance::write_preference(
        "departmentDetected",
        Value::String(department.clone()),
    )?;
    Ok(json!({
        "connected": true,
        "name": pku_portal::login::name_of(&info),
        "department": department,
    }))
}
pub(crate) fn portal_logout() -> Result<Value> {
    Store::new("portal")?.clear()?;
    Ok(json!({ "connected": false }))
}
/// 已选院系与候选清单，供设置页选择器使用。
pub(crate) fn department_state() -> Value {
    let (effective, source) = department_effective();
    json!({
        "selected": super::maintenance::read_preferences()
            .get("department")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "detected": super::maintenance::read_preferences()
            .get("departmentDetected")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "effective": effective,
        "source": source,
        "options": department_list(),
    })
}
pub(crate) fn set_department(value: &str) -> Result<Value> {
    let wanted = value.trim();
    if wanted.is_empty() {
        super::maintenance::write_preference("department", Value::Null)?;
        return Ok(department_state());
    }
    if resolve_department(wanted).is_none() {
        bail!("这个院系不在学院列表里，请重新选择");
    }
    super::maintenance::write_preference("department", Value::String(wanted.to_string()))?;
    Ok(department_state())
}
/// 本院通知：已适配的学院直接抓官网通知页，其余回退到门户部门通知按院系过滤。
async fn college_list(department: &str) -> Result<Value> {
    let (name, notice) =
        resolve_department(department).ok_or_else(|| anyhow!("未能识别院系列表，请在设置中手动选择"))?;
    if name == "信息科学技术学院" {
        // EECS 已有专用选择器，直接复用；行内标识改回本院，详情与打开才找得到。
        let bytes = body(
            client()?.get(home("eecs")?).send().await?,
            2 * 1024 * 1024,
        )
        .await?;
        let mut value = parse_listing("eecs", &String::from_utf8_lossy(&bytes))?;
        if let Some(rows) = value["items"].as_array_mut() {
            for row in rows.iter_mut() {
                row["source"] = "college".into();
                row["detail"] = "site".into();
            }
        }
        return Ok(value);
    }
    if let Some(target) = notice.map(|url| upgrade_http(&url)) {
        if let Ok(bytes) = body(
            client()?
                .get(&target)
                .header("referer", target.as_str())
                .send()
                .await?,
            2 * 1024 * 1024,
        )
        .await
        {
            // 学院站改版或证书异常时退回门户，而不是让通知页直接空掉。
            let items = parse_site(&String::from_utf8_lossy(&bytes), &target);
            if !items.is_empty() {
                return Ok(json!({
                    "items": items,
                    "hasMore": false,
                    "department": name,
                    "origin": "官网",
                }));
            }
        }
    }
    let items = portal_for_department(&core_of(&name)).await?;
    Ok(json!({
        "items": items,
        "hasMore": false,
        "department": name,
        "origin": "门户",
    }))
}
pub async fn list(source: &str, page: u32) -> Result<Value> {
    if source == "college" {
        super::page_valid(page)?;
        return college_list(&department_setting()?).await;
    }
    let source_home = home(source)?;
    super::page_valid(page)?;
    let c = client()?;
    if source == "library" {
        let now = chrono::Utc::now() + chrono::Duration::hours(8);
        let bytes = body(
            c.get("https://www.lib.pku.edu.cn/cms/front/content/list/all")
                .query(&[
                    ("currentPage", page.to_string()),
                    ("pageSize", "100".into()),
                    ("month", now.format("%m").to_string()),
                    ("year", now.format("%Y").to_string()),
                    ("siteId", "4b31754d8b064919b62798460f297002".into()),
                ])
                .send()
                .await?,
            2 * 1024 * 1024,
        )
        .await?;
        return parse_library(&serde_json::from_slice(&bytes)?, page);
    }
    if matches!(source, "school" | "department") {
        let endpoint = if source == "school" {
            "retrAllSchoolNotice.do"
        } else {
            "retrAllDeptNotice.do"
        };
        let (rows, total) = portal_rows(&c, endpoint, page).await?;
        let items=rows.iter().map(|r|{
            let id=r["Number"].as_str().unwrap_or("");
            json!({"id":id,"title":r["Title"],"date":r["Time"],"department":r["Department"],"source":source,
                "url":format!("{source_home}#/schoolNoticeDetail/{id}")})
        }).filter(|v|v["id"].as_str().is_some_and(|s|!s.is_empty())).collect::<Vec<_>>();
        return Ok(json!({"items":items,"hasMore":rows.len()==20,"total":total}));
    }
    if page != 1 {
        bail!("该来源只提供首页通知")
    }
    let bytes = body(c.get(source_home).send().await?, 2 * 1024 * 1024).await?;
    parse_listing(source, &String::from_utf8_lossy(&bytes))
}
fn library_time(value: &Value) -> String {
    let raw = value.as_str().unwrap_or("").trim();
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(date) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            return date.format("%Y-%m-%d %H:%M").to_string();
        }
    }
    String::new()
}
fn parse_library(v: &Value, page: u32) -> Result<Value> {
    if v["status"] != 200 {
        bail!("图书馆活动服务暂不可用")
    }
    let rows = v["object"]
        .as_array()
        .ok_or_else(|| anyhow!("图书馆活动数据格式变化"))?;
    let mut items = vec![];
    for r in rows {
        let title = r["name"].as_str().unwrap_or("").trim();
        let link = r["path"].as_str().unwrap_or("");
        if title.is_empty() || !school_url(link) {
            continue;
        }
        let u = url::Url::parse(link)?;
        if u.host_str() != Some("www.lib.pku.edu.cn") || !u.path().starts_with("/hdrl/") {
            continue;
        }
        let start = library_time(&r["kssj"]);
        let end = library_time(&r["jssj"]);
        // The CMS reuses articles each semester; the occurrence owns read state.
        let id = item_id("library", &format!("{link}|{start}|{end}"));
        let updated = library_time(&r["modifiedDate"]);
        let date = if updated.is_empty() {
            library_time(&r["publishDate"])
        } else {
            updated
        };
        items.push(json!({"id":id,"title":title,"url":link,"source":"library",
            "department":"图书馆","date":date,"dateLabel":"更新",
            "eventStart":start,"eventEnd":end,
            "location":r["hddd"].as_str().unwrap_or(""),
            "speaker":r["zcr"].as_str().unwrap_or("")}));
    }
    if !rows.is_empty() && items.is_empty() {
        bail!("图书馆活动未识别到内容，请阅读原站")
    }
    Ok(
        json!({"items":items,"hasMore":v["page"]["count"].as_u64().is_some_and(|n|n>u64::from(page)*100),"total":v["page"]["count"]}),
    )
}
fn parse_listing(source: &str, html: &str) -> Result<Value> {
    let base = home(source)?;
    let dom = Html::parse_document(html);
    let row_sel = selector(if source == "dean" {
        "div.notice_item"
    } else {
        "ul.list-text > li > a"
    });
    let mut items = vec![];
    for row in dom.select(&row_sel).take(40) {
        let (a, title, date) = if source == "dean" {
            let Some(a) = row.select(&selector("a")).next() else {
                continue;
            };
            (
                a,
                text_of(a),
                row.select(&selector("span"))
                    .next()
                    .map(text_of)
                    .unwrap_or_default(),
            )
        } else {
            let title = row
                .select(&selector(".tit"))
                .next()
                .map(text_of)
                .unwrap_or_default();
            let month = row
                .select(&selector(".date .mon"))
                .next()
                .map(text_of)
                .unwrap_or_default();
            let day = row
                .select(&selector(".date .day"))
                .next()
                .map(text_of)
                .unwrap_or_default();
            (row, title, format!("{month}-{day}"))
        };
        let Some(href) = a.value().attr("href") else {
            continue;
        };
        let url = url::Url::parse(base)?.join(href)?.to_string();
        if title.is_empty() || !school_url(&url) {
            continue;
        }
        items.push(
            json!({"id":item_id(source,&url),"title":title,"date":date,"source":source,
            "department":if source=="dean"{"教务部"}else{"信息科学技术学院"},"url":url}),
        );
    }
    if items.is_empty() {
        bail!("通知页面未识别到内容，可能需要更新适配")
    }
    Ok(json!({"items":items,"hasMore":false}))
}
pub async fn detail(source: &str, item: &Value) -> Result<Value> {
    let c = client()?;
    // 本院列表里门户转发的行只能走门户接口，官网抓到的行按原链接取正文。
    let from_portal = item["detail"] == "portal";
    let html = if matches!(source, "school" | "department")
        || (source == "college" && from_portal)
    {
        let bytes = body(
            c.post("https://portal.pku.edu.cn/portal2017/notice/getSchoolNoticeDetailById.do")
                .form(&[("id", item["id"].as_str().unwrap_or(""))])
                .send()
                .await?,
            3 * 1024 * 1024,
        )
        .await?;
        let v: Value = serde_json::from_slice(&bytes)?;
        if v["success"] != true {
            bail!("通知正文暂不可用")
        }
        v["notice"]["noticeContent"]
            .as_str()
            .ok_or_else(|| anyhow!("通知正文格式变化"))?
            .to_string()
    } else {
        let link = item["url"]
            .as_str()
            .ok_or_else(|| anyhow!("invalid notice link"))?;
        if !school_url(link) {
            bail!("invalid notice link")
        }
        let bytes = body(c.get(link).send().await?, 3 * 1024 * 1024).await?;
        let dom = Html::parse_document(&String::from_utf8_lossy(&bytes));
        let sel = selector(if source == "library" {
            ".article"
        } else if source == "eecs" {
            ".Section1, .v_news_content, .article"
        } else if source == "college" {
            // 各校 CMS 模板不同，按候选容器取正文最长的那个。
            ".v_news_content, .article, .content, .conttext, .newsinfo_box, article"
        } else {
            ".newsinfo_box"
        });
        dom.select(&sel)
            .max_by_key(|e| e.text().collect::<String>().len())
            .map(|e| {
                if source == "dean" {
                    e.children()
                        .filter_map(scraper::ElementRef::wrap)
                        .filter(|c| {
                            !matches!(c.value().name(), "h1" | "span")
                                && !c.value().classes().any(|x| x == "share_ds")
                        })
                        .map(|c| c.html())
                        .collect::<String>()
                } else {
                    e.inner_html()
                }
            })
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| anyhow!("正文暂不可用，请阅读原文"))?
    };
    let safe = ammonia::Builder::default()
        .add_tags(&["table", "thead", "tbody", "tr", "td", "th"])
        .url_relative(ammonia::UrlRelative::RewriteWithBase(url::Url::parse(
            item["url"].as_str().unwrap_or(home(source)?),
        )?))
        .link_rel(Some("noopener noreferrer"))
        .clean(&html)
        .to_string();
    Ok(json!({"html":safe,"url":item["url"]}))
}
pub fn open_link(s: &str) -> Result<()> {
    let u = url::Url::parse(s)?;
    if !matches!(u.scheme(), "https" | "http")
        || !u.username().is_empty()
        || u.password().is_some()
        || s.len() > 4000
    {
        bail!("invalid link")
    }
    platform::open(std::ffi::OsStr::new(u.as_str()))?;
    Ok(())
}
pub fn open_item(source: &str, item: &Value) -> Result<()> {
    home(source)?;
    let url = item["url"]
        .as_str()
        .ok_or_else(|| anyhow!("invalid notice"))?;
    if !school_url(url) {
        bail!("invalid notice link")
    }
    platform::open(std::ffi::OsStr::new(url))?;
    Ok(())
}
impl Core {
    pub(crate) fn news_item(&self, source: &str, id: &str) -> Result<Value> {
        home(source)?;
        self.cache
            .lock()
            .unwrap()
            .values()
            .filter_map(|e| e.data.as_ref())
            .filter_map(|d| d["items"].as_array())
            .flatten()
            .find(|v| v["source"] == source && v["id"] == id)
            .cloned()
            .ok_or_else(|| anyhow!("请先刷新通知列表"))
    }
}
pub fn calendar_url(year: &str) -> Result<&'static str> {
    Ok(match year {
        "2026-2027" => "https://simso.pku.edu.cn/files/simso/schoolcalendar/2627.pdf",
        "2025-2026" => "https://www.pku.edu.cn/Uploads/File/2025/01/17/u6789e9c75f2f9.pdf",
        _ => bail!("该学年校历尚未接入"),
    })
}
pub async fn calendar_pdf(year: &str) -> Result<Value> {
    let url = calendar_url(year)?;
    let bytes = body(client()?.get(url).send().await?, 8 * 1024 * 1024).await?;
    if !bytes.starts_with(b"%PDF-") {
        bail!("学校未返回校历 PDF")
    }
    Ok(json!({"year":year,"pdf":STANDARD.encode(bytes),"url":url}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn library_reused_articles_keep_current_occurrence_and_update_dates() {
        let mut response = json!({"status":200,"page":{"count":101},"object":[{
            "name":"一小时讲座","path":"https://www.lib.pku.edu.cn/hdrl/a.htm",
            "publishDate":"2023-10-19 16:16","modifiedDate":"2026-09-07 09:06",
            "kssj":"2026-12-02 15:10:00","jssj":"2026-12-02 16:40:00",
            "hddd":"208+在线","zcr":"讲者"
        }]});
        let first = parse_library(&response, 1).unwrap();
        assert_eq!(first["items"][0]["date"], "2026-09-07 09:06");
        assert_eq!(first["items"][0]["eventStart"], "2026-12-02 15:10");
        assert_eq!(first["items"][0]["location"], "208+在线");
        assert_eq!(first["hasMore"], true);
        response["object"][0]["kssj"] = json!("2027-03-02 15:10:00");
        let second = parse_library(&response, 2).unwrap();
        assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
        assert_eq!(second["hasMore"], false);
        assert!(parse_library(&json!({"status":200,"object":{}}), 1).is_err());
        assert!(parse_library(&json!({"status":500,"object":[]}), 1).is_err());
        assert_eq!(
            parse_library(&json!({"status":200,"object":[]}), 1).unwrap()["items"],
            json!([])
        );
        assert!(library_time(&json!("2026-02-31 15:10:00")).is_empty());
        response["object"][0]["path"] = json!("https://evil.test/a.htm");
        assert!(parse_library(&response, 1).is_err());
    }
    #[test]
    fn notices_keep_source_date_and_stable_ids() {
        let v=parse_listing("dean",r#"<div class="notice_item"><span>2026-09-01</span><a href="notice_details.php?id=42">选课通知</a></div>"#).unwrap();
        assert_eq!(v["items"][0]["title"], "选课通知");
        assert_eq!(v["items"][0]["date"], "2026-09-01");
        assert_eq!(
            v["items"][0]["url"],
            "https://dean.pku.edu.cn/web/notice_details.php?id=42"
        );
        assert!(parse_listing("dean", "<html>登录</html>").is_err());
    }
    #[test]
    fn external_redirects_and_fake_school_domains_are_rejected() {
        assert!(school_url("https://dean.pku.edu.cn/web/notice.php"));
        for url in [
            "https://pku.edu.cn.evil.test/",
            "http://portal.pku.edu.cn/",
            "https://x@pku.edu.cn/",
            "file:///tmp/a",
        ] {
            assert!(!school_url(url));
        }
    }
    #[test]
    fn departments_are_claimed_by_word_root() {
        let options = department_list();
        assert!(options.len() > 50, "{} 个院系", options.len());
        assert!(options.contains(&"数学科学学院".to_string()));
        assert_eq!(core_of("生命科学学院"), "生命科学");
        // 同院异写按词根认领；目录里没有的不猜。
        assert_eq!(resolve_department("生命学院").unwrap().0, "生命科学学院");
        assert_eq!(resolve_department("物理").unwrap().0, "物理学院");
        assert_eq!(
            resolve_department("物理学院").unwrap().1,
            Some("https://www.phy.pku.edu.cn/xwgg/tzgg.htm".to_string())
        );
        assert_eq!(resolve_department("数学科学学院").unwrap().1, None);
        assert!(resolve_department("航天航空学院不存在").is_none());
        assert!(resolve_department("").is_none());
    }
    #[test]
    fn plain_http_is_upgraded_only_inside_campus_domains() {
        assert_eq!(
            upgrade_http("http://www.chem.pku.edu.cn/x.htm"),
            "https://www.chem.pku.edu.cn/x.htm"
        );
        assert_eq!(
            upgrade_http("http://www.bjmu.edu.cn/x.htm"),
            "https://www.bjmu.edu.cn/x.htm"
        );
        assert_eq!(upgrade_http("http://example.com/x.htm"), "http://example.com/x.htm");
        assert_eq!(upgrade_http("https://fs.pku.edu.cn/"), "https://fs.pku.edu.cn/");
    }
    #[test]
    fn site_listing_requires_detail_link_title_and_nearby_date() {
        let html = r#"<html><body><ul>
            <li><a href="/info/1234.htm" title="关于 2026 年研究生复试安排的通知">详情</a><span>2026/05/06</span></li>
            <li><a href="/index.htm">首页</a><span>2026-05-06</span></li>
            <li><a href="/info/1235.htm" title="短">短</a><span>2026-05-07</span></li>
            <li><a href="https://other.example.com/info/y.htm" title="外站的较长通知标题示例">外部</a><span>2026-05-08</span></li>
            <li><a href="/tzgg/2026/0507.htm" title="2026-05-07 标题里的日期前缀要清掉">更多</a><span>2026-05-07</span></li>
        </ul>
        <div class="isolated"><div><div><a href="/info/1236.htm" title="没有日期就整条丢弃的较长通知标题">详情</a></div></div></div>
        </body></html>"#;
        let items = parse_site(html, "https://www.phy.pku.edu.cn/xwgg/tzgg.htm");
        assert_eq!(items.len(), 2, "{items:?}");
        // 按日期倒序，日期从链接上方最多三层文本里找。
        assert_eq!(items[0]["title"], "标题里的日期前缀要清掉");
        assert_eq!(items[0]["date"], "2026-05-07");
        assert_eq!(items[1]["title"], "关于 2026 年研究生复试安排的通知");
        assert_eq!(items[1]["url"], "https://www.phy.pku.edu.cn/info/1234.htm");
        assert_eq!(items[1]["source"], "college");
        assert_eq!(items[1]["detail"], "site");
        assert!(items[0]["id"].as_str().unwrap().starts_with("college-"));
    }
}
