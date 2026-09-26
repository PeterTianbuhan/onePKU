//! PKU portal/dean request contracts adapted from ha0xin/pku-coe-notice-helper
//! (MIT). See docs/licenses. EECS selectors verified against the official site;
//! RSSHub's PKU route catalogue supplied source discovery, not copied code.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use scraper::{Html, Selector};

fn home(source: &str) -> Result<&'static str> {
    Ok(match source {
        "school" | "department" => "https://portal.pku.edu.cn/portal2017/",
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
pub async fn list(source: &str, page: u32) -> Result<Value> {
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
        let bytes = body(
            c.post(format!("{source_home}notice/{endpoint}"))
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
        let v: Value = serde_json::from_slice(&bytes)?;
        if v["success"] != true {
            bail!("学校通知服务未返回数据")
        }
        let rows = v["rows"]
            .as_array()
            .ok_or_else(|| anyhow!("通知数据格式变化"))?;
        let items=rows.iter().map(|r|{
            let id=r["Number"].as_str().unwrap_or("");
            json!({"id":id,"title":r["Title"],"date":r["Time"],"department":r["Department"],"source":source,
                "url":format!("{source_home}#/schoolNoticeDetail/{id}")})
        }).filter(|v|v["id"].as_str().is_some_and(|s|!s.is_empty())).collect::<Vec<_>>();
        return Ok(json!({"items":items,"hasMore":rows.len()==20,"total":v["results"]}));
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
    let html = if matches!(source, "school" | "department") {
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
}
