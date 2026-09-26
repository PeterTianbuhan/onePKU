//! School-specific public notices, adapted from the Android contribution.
use super::*;
use scraper::{Html, Selector};

fn directory(school: &str) -> Result<Value> {
    let schools: Value = serde_json::from_str(include_str!("../../../data/schools.json"))?;
    schools
        .get(school)
        .cloned()
        .ok_or_else(|| anyhow!("未知院系"))
}
fn core_name(s: &str) -> &str {
    ["学院", "研究所", "系"]
        .iter()
        .find_map(|suffix| s.strip_suffix(suffix))
        .unwrap_or(s)
}
fn belongs_to(department: &str, school: &str) -> bool {
    let core = core_name(school);
    core.chars().count() >= 2 && department.contains(core)
}
fn parse_site(html: &str, base: &str, school: &str) -> Result<Vec<Value>> {
    let document = Html::parse_document(html);
    let base = url::Url::parse(base)?;
    let detail = regex::Regex::new(
        r"/(info|content|notice|news|tzgg|xwgg|art)/|/\d{5,}\.s?html?$|\d{3,}\.s?html?$",
    )?;
    let date_re = regex::Regex::new(r"(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})")?;
    let selector = Selector::parse("a[href]").unwrap();
    let mut rows = std::collections::BTreeMap::new();
    for link in document.select(&selector) {
        let Some(url) = link.value().attr("href").and_then(|s| base.join(s).ok()) else {
            continue;
        };
        if url.scheme() != "https"
            || url.host_str() != base.host_str()
            || !detail.is_match(url.path())
        {
            continue;
        }
        let title = link
            .value()
            .attr("title")
            .map(str::to_owned)
            .unwrap_or_else(|| link.text().collect::<String>())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.chars().count() < 6 {
            continue;
        }
        let date = link
            .ancestors()
            .take(3)
            .filter_map(scraper::ElementRef::wrap)
            .find_map(|el| {
                let text = el.text().collect::<Vec<_>>().join(" ");
                let mut dates = date_re.captures_iter(&text);
                let parts = dates.next()?;
                if dates.next().is_some() {
                    return None;
                }
                chrono::NaiveDate::from_ymd_opt(
                    parts[1].parse().ok()?,
                    parts[2].parse().ok()?,
                    parts[3].parse().ok()?,
                )
                .map(|d| d.to_string())
            });
        let Some(date) = date else { continue };
        let id = format!("{:x}", Sha256::digest(url.as_str()));
        rows.entry(url.to_string()).or_insert(json!({"id":id, "source":"faculty", "title":title, "date":date, "department":school, "url":url.as_str()}));
    }
    // A changed parser is not evidence of no notices; try the portal instead.
    anyhow::ensure!(!rows.is_empty(), "学院通知页未识别到内容");
    let mut rows: Vec<_> = rows.into_values().collect();
    rows.sort_by(|a, b| b["date"].as_str().cmp(&a["date"].as_str()));
    rows.truncate(40);
    Ok(rows)
}

pub(crate) async fn list(school: &str, page: u32) -> Result<(Value, Vec<String>)> {
    page_valid(page)?;
    let site = directory(school)?;
    let mut warnings = vec![];
    if page == 1 || school == "信息科学技术学院" {
        if let Some(url) = site["notice"].as_str() {
            let result = async {
                if school == "信息科学技术学院" {
                    return Ok(news::list("eecs", page).await?);
                }
                let bytes = news::body(news::client()?.get(url).send().await?, 2 * 1024 * 1024).await?;
                Ok::<_, anyhow::Error>(json!({"items":parse_site(&String::from_utf8_lossy(&bytes), url, school)?, "hasMore":false}))
            }.await;
            match result {
                Ok(mut value) => {
                    value["origin"] = json!("学院官网");
                    return Ok((value, warnings));
                }
                Err(_) => warnings.push("学院官网暂未读取成功，当前改为筛选门户部门通知".into()),
            }
        }
    }
    let result = news::list("department", page).await?;
    let rows = result["items"]
        .as_array()
        .ok_or_else(|| anyhow!("门户通知格式变化"))?;
    let selected: Vec<_> = rows
        .iter()
        .filter(|row| belongs_to(row["department"].as_str().unwrap_or(""), school))
        .cloned()
        .collect();
    Ok((
        json!({"items": selected,"hasMore":result["hasMore"],"origin":"门户部门通知", "page":page}),
        warnings,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notices_require_detail_urls_and_valid_dates() {
        let html = r#"<ul><li>2026-09-26 <a href='/info/1010/12345.htm'>本科教学课程通知</a></li><li>2026-99-99 <a href='/info/1010/44444.htm'>无效日期公告通知</a></li><li>2026-09-25 <a href='https://evil.example/info/11111.htm'>外部不可信公告</a></li></ul>"#;
        let rows = parse_site(html, "https://cs.pku.edu.cn/xyxw/tzgg.htm", "计算机学院").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["date"], "2026-09-26");
        assert!(parse_site("<p>页面已改版</p>", "https://cs.pku.edu.cn/", "计算机学院").is_err());
    }
    #[test]
    fn school_filter_does_not_match_other_departments() {
        assert!(belongs_to("计算机学院教务办公室", "计算机学院"));
        assert!(!belongs_to("物理学院", "计算机学院"));
        assert!(directory("计算机学院").is_ok());
        assert!(directory("未知学院").is_err());
    }
}
