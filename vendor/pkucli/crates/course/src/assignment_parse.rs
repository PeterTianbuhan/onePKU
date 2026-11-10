use crate::{
    api::{AssignmentDetail, Attachment},
    client::COURSE_BASE,
};
use anyhow::{ensure, Result};
use scraper::{ElementRef, Html, Selector};
use std::collections::HashSet;

fn text(element: ElementRef<'_>) -> String {
    element
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn label_matches(label: &str, labels: &[&str]) -> bool {
    let label = label.trim_end_matches([':', '：']).trim();
    labels.iter().any(|value| label.eq_ignore_ascii_case(value))
}

fn metadata(dom: &Html, labels: &[&str]) -> Option<String> {
    let label = Selector::parse(".metaLabel").unwrap();
    let value = Selector::parse(".metaField").unwrap();
    for section in dom.select(&Selector::parse("#metadata .metaSection").unwrap()) {
        if section
            .select(&label)
            .next()
            .is_some_and(|e| label_matches(&text(e), labels))
        {
            if let Some(value) = section
                .select(&value)
                .next()
                .map(text)
                .filter(|s| !s.is_empty())
            {
                return Some(value);
            }
        }
    }
    for heading in dom.select(&Selector::parse("#assignmentInfo h3").unwrap()) {
        if label_matches(&text(heading), labels) {
            if let Some(value) = heading
                .next_siblings()
                .filter_map(ElementRef::wrap)
                .next()
                .map(text)
                .filter(|s| !s.is_empty())
            {
                return Some(value);
            }
        }
    }
    None
}

pub(crate) fn attachment(anchor: ElementRef<'_>) -> Option<Attachment> {
    let name = anchor.text().collect::<String>().trim().to_owned();
    let href = anchor.value().attr("href")?.trim();
    if name.is_empty() || href.is_empty() || href.starts_with('#') {
        return None;
    }
    let url = reqwest::Url::parse(COURSE_BASE).ok()?.join(href).ok()?;
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    Some(Attachment {
        name,
        url: url.to_string(),
    })
}

pub(crate) fn parse(body: &str) -> Result<AssignmentDetail> {
    let dom = Html::parse_document(body);
    // `.itemdates` / `span.title` keep pages the previous parser accepted.
    ensure!(
        dom.select(
            &Selector::parse(
                "#uploadAssignmentFormId, #assignmentInfo, #currentAttempt, .itemdates, span.title, #pageTitleText"
            )
            .unwrap()
        )
        .next()
        .is_some(),
        "无法识别教学网作业页面"
    );
    let title = metadata(&dom, &["名称", "Name"]).unwrap_or_else(|| {
        let title = dom
            .select(&Selector::parse("span.title, #pageTitleText").unwrap())
            .next()
            .map(text)
            .unwrap_or_default();
        for prefix in [
            "上载作业：",
            "上载作业:",
            "复查提交历史记录:",
            "复查提交历史记录：",
            "Upload Assignment:",
            "Review Submission History:",
        ] {
            if let Some(value) = title.strip_prefix(prefix) {
                return value.trim().to_owned();
            }
        }
        title
    });
    ensure!(!title.is_empty(), "教学网作业页面缺少标题");
    let deadline = metadata(&dom, &["到期日期", "截止日期", "Due Date"]).or_else(|| {
        dom.select(&Selector::parse(".itemdates").unwrap())
            .next()
            .map(text)
            .filter(|s| !s.is_empty())
    });
    let instructions = [
        "#instructions div.vtbegenerated",
        "#contentDetails div.vtbegenerated",
        "div.vtbegenerated",
    ]
    .iter()
    .find_map(|selector| dom.select(&Selector::parse(selector).unwrap()).next())
    .map(|e| e.text().collect::<String>().trim().to_owned())
    .unwrap_or_default();
    let mut seen = HashSet::new();
    let attachments = dom
        .select(&Selector::parse("ul.attachments li a, #assignmentInfo a[href]").unwrap())
        .filter_map(attachment)
        .filter(|a| seen.insert(a.url.clone()))
        .collect();
    let explicit_status = dom
        .select(&Selector::parse(".status").unwrap())
        .next()
        .map(text)
        .filter(|s| !s.is_empty());
    let attempt = dom
        .select(&Selector::parse("#currentAttempt_label").unwrap())
        .next()
        .map(text)
        .filter(|s| !s.is_empty());
    let status = explicit_status.unwrap_or_else(|| {
        if attempt.as_ref().is_some_and(|label| {
            label.contains("草稿") || label.to_ascii_lowercase().contains("draft")
        }) {
            "草稿".into()
        } else if attempt.is_some()
            && dom
                .select(&Selector::parse("#currentAttempt_submission").unwrap())
                .next()
                .is_some()
        {
            "已提交".into()
        } else if attempt.is_none()
            && dom
                .select(&Selector::parse("#uploadAssignmentFormId").unwrap())
                .next()
                .is_some()
        {
            "未提交".into()
        } else {
            "未知".into()
        }
    });
    Ok(AssignmentDetail {
        title,
        deadline,
        instructions,
        attachments,
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::parse_deadline;

    fn deadline_iso(raw: &str) -> String {
        parse_deadline(raw)
            .unwrap()
            .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
            .to_rfc3339()
    }

    #[test]
    fn upload_metadata_uses_due_date_not_the_unrelated_score_or_instruction_date() {
        let result = parse(r#"<span class="title">上载作业： 测试作业</span>
            <form id="uploadAssignmentFormId"><li id="metadata">
            <div class="metaSection"><div class="metaLabel">到期日期</div><div class="metaField">2026年10月8日 星期四 下午11:59</div></div>
            <div class="metaSection"><div class="metaLabel">满分</div><div class="metaField">10</div></div></li>
            <li id="instructions"><div class="vtbegenerated">说明中提及2025年1月1日</div></li></form>"#).unwrap();
        assert_eq!(result.title, "测试作业");
        assert_eq!(result.status, "未提交");
        assert_eq!(
            deadline_iso(result.deadline.as_deref().unwrap()),
            "2026-10-08T23:59:00+08:00"
        );
    }

    #[test]
    fn submitted_history_keeps_due_date_and_teacher_files_separate_from_uploaded_files() {
        let result = parse(r#"<div id="assignmentInfo"><div><h3>名称</h3><p>测试作业</p></div>
            <div><h3>到期日期</h3><p>2026年9月23日 下午11:59</p></div>
            <div><h3>作业文件</h3><p><a href="/bbcswebdav/homework.md">homework.md</a></p></div></div>
            <div id="currentAttempt"><h3 id="currentAttempt_label">尝试 1</h3>
            <div id="currentAttempt_submission"><ul id="currentAttempt_submissionList">
            <a href="/bbcswebdav/student.zip">student.zip</a></ul></div></div>"#).unwrap();
        assert_eq!(result.status, "已提交");
        assert_eq!(result.attachments.len(), 1);
        assert_eq!(result.attachments[0].name, "homework.md");
        assert_eq!(
            deadline_iso(result.deadline.as_deref().unwrap()),
            "2026-09-23T23:59:00+08:00"
        );
    }

    #[test]
    fn dates_without_weekdays_and_midnight_are_supported() {
        for (raw, expected) in [
            (
                "2026年10月20日 星期二 上午12:30",
                "2026-10-20T00:30:00+08:00",
            ),
            (
                "2026 年 10 月 8 日 下午 11:59:59",
                "2026-10-08T23:59:59+08:00",
            ),
        ] {
            assert_eq!(deadline_iso(raw), expected);
        }
    }

    #[test]
    fn legacy_itemdates_page_still_parses() {
        let result = parse(
            r#"<span class="title">旧版作业</span><div class="itemdates">2026年3月15日 星期日 下午11:59</div><div class="vtbegenerated">说明</div>"#,
        )
        .unwrap();
        assert_eq!(result.title, "旧版作业");
        assert_eq!(result.instructions, "说明");
        assert_eq!(result.status, "未知");
        assert_eq!(
            deadline_iso(result.deadline.as_deref().unwrap()),
            "2026-03-15T23:59:00+08:00"
        );
    }

    #[test]
    fn draft_is_not_submitted_and_absent_due_date_stays_absent() {
        let result = parse(r#"<div id="assignmentInfo"><h3>名称</h3><p>草稿测试</p></div>
            <h3 id="currentAttempt_label">Draft attempt</h3><div id="currentAttempt_submission"></div>"#).unwrap();
        assert_eq!(result.status, "草稿");
        assert!(result.deadline.is_none());
        assert!(parse("<h1>登录失败</h1>").is_err());
    }

    #[test]
    fn attachment_controls_and_duplicate_links_are_ignored() {
        let result = parse(r##"<span class="title">测试</span><form id="uploadAssignmentFormId">
            <ul class="attachments"><li><a href="/bbcswebdav/hw.pdf">hw.pdf</a>
            <a href="#">菜单</a><a href="javascript:void(0)">控件</a>
            <a href="/bbcswebdav/empty"></a><a href="/bbcswebdav/hw.pdf">hw.pdf</a></li></ul></form>"##).unwrap();
        assert_eq!(result.attachments.len(), 1);
    }
}
