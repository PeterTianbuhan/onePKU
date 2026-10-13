use super::*;
use chrono::{Datelike, NaiveDate};
/// 结尾括号里的学期写法统一成「26-27学年第1学期」。教学网的学期后缀不止一种写法
/// （「26-27学年第1学期」「26-27-1」「2026-2027 学年第一学期」），只认一种就会把
/// 整串带进培养方案的课程名匹配，在修课程因此认不出来；不像学期的括号原样保留。
fn term_label(inner: &str) -> Option<String> {
    let text = inner.trim();
    let years = regex::Regex::new(r"(\d{2,4})\s*[-—–－]\s*(\d{2,4})").unwrap();
    let caps = years.captures(text)?;
    let short = |value: &str| value[value.len() - 2..].to_string();
    let number = regex::Regex::new(r"第\s*([0-9一二三])\s*学期")
        .unwrap()
        .captures(text)
        .map(|found| {
            match &found[1] {
                "一" => "1",
                "二" => "2",
                "三" => "3",
                other => other,
            }
            .to_string()
        })
        .or_else(|| {
            regex::Regex::new(r"[-—–－]\s*([123])\s*$")
                .unwrap()
                .captures(text)
                .map(|found| found[1].to_string())
        });
    Some(match number {
        Some(number) => format!("{}-{}学年第{}学期", short(&caps[1]), short(&caps[2]), number),
        None => format!("{}-{}学年", short(&caps[1]), short(&caps[2])),
    })
}
pub(crate) fn course_value(c: &pku_course::api::CourseInfo) -> Value {
    // 「26271-x: 数据结构 (26-27学年第1学期)」：冒号前是课程编号，结尾括号是学期。
    let title = c
        .long_title
        .split_once([':', '：'])
        .map(|(_, t)| t.trim())
        .unwrap_or(c.long_title.trim());
    let suffix = regex::Regex::new(r"[（(]([^（）()]*)[）)]\s*$").unwrap();
    let tail = suffix.captures(title).map(|found| found[1].to_string());
    let term = tail.as_deref().and_then(term_label);
    let name = if term.is_some() {
        suffix.replace(title, "").trim().to_string()
    } else {
        title.to_string()
    };
    let semester = term.or_else(|| {
        let prefix = regex::Regex::new(r"^(\d{2})(\d{2})([123])-").unwrap();
        prefix
            .captures(&c.long_title)
            .map(|m| format!("{}-{}学年第{}学期", &m[1], &m[2], &m[3]))
    });
    json!({
        "id": c.id,
        "name": name,
        "semester": semester.unwrap_or_else(|| "未标注学期".into()),
        "current": c.is_current,
    })
}
fn month_range(month: &str) -> Result<(NaiveDate, NaiveDate)> {
    if month.len() != 7
        || !month.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 4 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        bail!("invalid month")
    }
    let first = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d")?;
    if !(2000..=2100).contains(&first.year()) {
        bail!("invalid month")
    }
    let next = if first.month() == 12 {
        NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)
    }
    .unwrap();
    Ok((first, next.pred_opt().unwrap()))
}
pub struct CourseBrowserCookie {
    pub name: String,
    pub value: String,
    pub path: String,
    pub http_only: bool,
}
impl Core {
    /// Native browser only; never returned by a frontend Request.
    pub fn course_browser_cookies(&self, target: &str) -> Result<Vec<CourseBrowserCookie>> {
        let target = url::Url::parse(target)?;
        anyhow::ensure!(
            target.scheme() == "https" && target.host_str() == Some("course.pku.edu.cn"),
            "无效教学网地址"
        );
        self.course_api()?.persist_cookies()?;
        let jar = Store::new("course")?.load_cookie_store()?;
        let guard = jar.lock().unwrap();
        Ok(guard
            .iter_unexpired()
            .filter(|c| c.matches(&target))
            .map(|c| CourseBrowserCookie {
                name: c.name().into(),
                value: c.value().into(),
                path: c.path.as_ref().into(),
                http_only: c.http_only().unwrap_or(false),
            })
            .collect())
    }

    pub(crate) async fn course_notices(&self, course: &str) -> Result<Value> {
        let metadata = self.find_course(course).await?;
        let notices = self.course_api()?.list_announcements(course).await?;
        Ok(json!(notices.into_iter().map(|announcement| json!({"course_id":course,"course_name":metadata["name"],"announcement":announcement})).collect::<Vec<_>>()))
    }
    pub(crate) async fn assignment_feedback(
        &self,
        course: &str,
        content: &str,
        warnings: &mut Vec<String>,
    ) -> Result<Value> {
        valid_id(content)?;
        let metadata = self.find_course(course).await?;
        let feedback = self
            .course_api()?
            .assignment_feedback(course, content)
            .await?;
        warnings.extend(feedback.warnings.clone());
        let mut value = serde_json::to_value(feedback)?;
        if let Some(attempts) = value["attempts"].as_array_mut() {
            for attempt in attempts {
                let mut rows = vec![
                    json!({"course_id":course,"course_name":metadata["name"],"semester":metadata["semester"],"attachments":attempt["files"]}),
                ];
                self.register_files(&mut rows);
                attempt["files"] = rows.remove(0)["attachments"].take();
            }
        }
        Ok(value)
    }

    pub(crate) async fn course_assignments(
        &self,
        id: &str,
        warnings: &mut Vec<String>,
    ) -> Result<Value> {
        valid_id(id)?;
        let api = self.course_api()?;
        let courses = api.list_courses(false).await?;
        let c = courses
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| anyhow!("课程不在当前账号列表中"))?;
        let metadata = course_value(c);
        let mut rows = api
            .list_assignments_for_course(c)
            .await?
            .into_iter()
            .map(|a| serde_json::to_value(a).unwrap())
            .collect::<Vec<_>>();
        for row in &mut rows {
            apply_course_metadata(row, &metadata);
            if row["detail_error"] == true {
                warnings.push(format!(
                    "{} 的详情尚未获取",
                    row["title"].as_str().unwrap_or("作业")
                ));
            }
        }
        self.register_files(&mut rows);
        Ok(json!(rows))
    }
    pub(crate) async fn all_courses(&self) -> Result<Value> {
        Ok(json!(self
            .course_api()?
            .list_courses(false)
            .await?
            .iter()
            .map(course_value)
            .collect::<Vec<_>>()))
    }
    pub(crate) async fn find_course(&self, id: &str) -> Result<Value> {
        valid_id(id)?;
        self.all_courses()
            .await?
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
            .ok_or_else(|| anyhow!("课程不在当前账号列表中"))
    }
    /// 回放只要好学源：直接拿课名去课堂实录里查，不再经过教学网账号。
    pub(crate) async fn videos(&self, name: &str, warnings: &mut Vec<String>) -> Result<Value> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 200 {
            bail!("invalid course");
        }
        let (rows, waiting) = crate::haoxue::replays(name).await?;
        if waiting > 0 {
            warnings.push(format!("另有 {waiting} 节课堂记录没有可播放回放"));
        }
        Ok(Value::Array(rows))
    }
    pub(crate) async fn exams(&self) -> Result<Value> {
        let rows = pku_treehole::api::TreeholeApi::from_session_noninteractive()
            .await?
            .get_coursetable()
            .await
            .map_err(|e| {
                if e.to_string().contains("TIMETABLE_SOURCE_UNAVAILABLE") {
                    anyhow!("EXAMS_SOURCE_UNAVAILABLE")
                } else {
                    e
                }
            })?;
        let mut exams = vec![];
        for row in rows {
            for slot in row.slots.into_iter().flatten() {
                if let Some((_, detail)) = slot
                    .details
                    .split_once("考试信息：")
                    .or_else(|| slot.details.split_once("考试信息:"))
                {
                    let detail = detail.trim();
                    if !detail.is_empty() {
                        let item = json!({"course":slot.course_name,"detail":detail});
                        if !exams.contains(&item) {
                            exams.push(item);
                        }
                    }
                }
            }
        }
        Ok(json!(exams))
    }
    pub(crate) async fn card_stats(&self, month: &str, part: &str) -> Result<Value> {
        let (first, last) = month_range(month)?;
        let a = pku_campuscard::api::CardApi::new(&maintenance::card_token()?)?;
        Ok(match part {
            "total" => serde_json::to_value(a.get_turnover_count(&first, &last).await?)?,
            "daily" => serde_json::to_value(a.get_daily_stats(month, 2).await?)?,
            "category" => serde_json::to_value(a.get_category_stats(&first, &last, 2).await?)?,
            _ => bail!("invalid statistics part"),
        })
    }
}
pub(crate) fn apply_course_metadata(row: &mut Value, metadata: &Value) {
    row["course_id"] = metadata["id"].clone();
    row["course_name"] = metadata["name"].clone();
    row["semester"] = metadata["semester"].clone();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terms_preserve_course_parentheses() {
        let c = pku_course::api::CourseInfo {
            id: "_1_1".into(),
            long_title: "26271-x: 数据结构 (A) (实验班)(26-27学年第1学期)".into(),
            is_current: true,
        };
        let v = course_value(&c);
        assert_eq!(v["name"], "数据结构 (A) (实验班)");
        assert_eq!(v["semester"], "26-27学年第1学期");
        let c = pku_course::api::CourseInfo {
            long_title: "25261-x: 视频课程".into(),
            ..c
        };
        assert_eq!(course_value(&c)["semester"], "25-26学年第1学期");
    }
    #[test]
    fn every_term_spelling_leaves_a_bare_course_name() {
        // 学期后缀写法不统一，认不全就会把整串带进培养方案匹配，在修课程少一类。
        for (title, name, semester) in [
            ("26271-x: 高等数学A (2026-2027 学年第一学期)", "高等数学A", "26-27学年第1学期"),
            ("26271-x: 大学物理 (26-27-2)", "大学物理", "26-27学年第2学期"),
            ("26271-x: 综合英语（三）(26-27学年第3学期)", "综合英语（三）", "26-27学年第3学期"),
            ("26271-x: 代数与数论 (26-27)", "代数与数论", "26-27学年"),
        ] {
            let value = course_value(&pku_course::api::CourseInfo {
                id: "_1_1".into(),
                long_title: title.into(),
                is_current: true,
            });
            assert_eq!(value["name"], name, "{title}");
            assert_eq!(value["semester"], semester, "{title}");
        }
        // 不像学期的括号是课程名的一部分，必须留着。
        let value = course_value(&pku_course::api::CourseInfo {
            id: "_1_1".into(),
            long_title: "26271-x: 综合英语 (上)".into(),
            is_current: true,
        });
        assert_eq!(value["name"], "综合英语 (上)");
        assert_eq!(value["semester"], "26-27学年第1学期");
    }
    #[test]
    fn month_boundaries() {
        assert_eq!(month_range("2024-02").unwrap().1.to_string(), "2024-02-29");
        assert_eq!(month_range("2026-12").unwrap().1.to_string(), "2026-12-31");
        for s in ["2026-13", "2026-1", "../test", "0000-01"] {
            assert!(month_range(s).is_err());
        }
    }
    #[test]
    fn full_year_and_full_width_titles_share_the_same_semester() {
        for title in [
            "26271-x：数据结构 (A) （2026-2027学年第1学期）",
            "26271-x: 数据结构 (A) (26－27 学年第一学期) ",
            "26271-x: 数据结构 (A)",
        ] {
            let value = course_value(&pku_course::api::CourseInfo {
                id: "_1_1".into(), long_title: title.into(), is_current: true,
            });
            assert_eq!(value["name"], "数据结构 (A)");
            assert_eq!(value["semester"], "26-27学年第1学期");
        }
    }
    #[test]
    fn assignment_metadata_matches_course_material_archive() {
        let metadata = json!({"id":"_1_1","name":"数据结构 (A)","semester":"26-27学年第1学期"});
        let mut row = json!({"course_name":"数据结构","attachments":[]});
        apply_course_metadata(&mut row, &metadata);
        assert_eq!(row["course_name"], metadata["name"]);
        assert_eq!(row["course_id"], metadata["id"]);
        assert_eq!(row["semester"], metadata["semester"]);
    }
    #[test]
    fn attachment_preview_requests_share_the_course_account() {
        for request in [
            Request::Download { id: "file".into() },
            Request::DownloadStatus { id: "job".into() },
            Request::LocalMaterials { course: "_1_1".into() },
        ] {
            assert_eq!(owner(&request), "course");
        }
    }
}
