//! 培养方案原文：按需下载教务部公开的整卷 PDF（只缓存一次），抽出某个专业所在的几页。
//! 卷目与下载地址来自仓库内 scripts/curriculum/volumes.json，前端只能传卷 id 和页码，不能传 URL。
use crate::{downloads::folder_component, news};
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;

const VOLUMES: &str = include_str!("../../../scripts/curriculum/volumes.json");
const VOLUME_LIMIT: usize = 200 * 1024 * 1024;
const MAX_PAGES: u32 = 60;

fn volume(id: &str) -> Result<(String, String)> {
    let manifest: Value = serde_json::from_str(VOLUMES)?;
    manifest["volumes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["id"] == id)
        .map(|v| {
            (
                v["title"].as_str().unwrap_or(id).to_string(),
                v["url"].as_str().unwrap_or_default().to_string(),
            )
        })
        .filter(|(_, url)| url.starts_with("https://dean.pku.edu.cn/"))
        .ok_or_else(|| anyhow!("没有这一卷培养方案"))
}

fn cache_path(id: &str) -> Result<PathBuf> {
    let dir = directories::ProjectDirs::from("me", "petertian", "OnePKU")
        .ok_or_else(|| anyhow!("无法定位缓存目录"))?
        .cache_dir()
        .join("curriculum");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.pdf", folder_component(id))))
}

async fn volume_bytes(id: &str, url: &str) -> Result<Vec<u8>> {
    let path = cache_path(id)?;
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if bytes.starts_with(b"%PDF-") {
            return Ok(bytes);
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .user_agent("OnePKU/0.6 (personal campus reader)")
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let bytes = news::body(client.get(url).send().await?, VOLUME_LIMIT).await?;
    if !bytes.starts_with(b"%PDF-") {
        bail!("教务部未返回 PDF，请稍后再试");
    }
    let temp = path.with_extension("part");
    tokio::fs::write(&temp, &bytes).await?;
    tokio::fs::rename(&temp, &path).await?;
    Ok(bytes)
}

fn extract(bytes: Vec<u8>, from: u32, to: u32) -> Result<(Vec<u8>, u32)> {
    let mut doc = lopdf::Document::load_mem(&bytes)?;
    let total = doc.get_pages().len() as u32;
    if total == 0 || from > total {
        bail!("原卷只有 {total} 页，找不到第 {from} 页");
    }
    let to = to.min(total);
    let delete: Vec<u32> = (1..=total).filter(|p| *p < from || *p > to).collect();
    doc.delete_pages(&delete);
    doc.prune_objects();
    doc.renumber_objects();
    doc.compress();
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok((out, to - from + 1))
}

fn title_component(title: &str, limit: usize) -> String {
    let mut end = title.len().min(limit);
    while !title.is_char_boundary(end) {
        end -= 1;
    }
    folder_component(&title[..end])
}

/// 返回抽出的几页（base64），并保存到当前保存目录的培养方案文件夹；open 为真时用系统默认应用打开。
pub async fn pages(id: &str, from: u32, to: u32, title: &str, open: bool) -> Result<Value> {
    if from == 0 || to < from {
        bail!("页码无效");
    }
    if to - from + 1 > MAX_PAGES {
        bail!("一次最多抽取 {MAX_PAGES} 页");
    }
    let (volume_title, url) = volume(id)?;
    // 抽出的几页也缓存：整卷解析要几秒，同一专业再次打开直接读切片。
    let slice_path = cache_path(&format!("{id}-p{from}-{to}"))?;
    let cached = tokio::fs::read(&slice_path)
        .await
        .ok()
        .filter(|b| b.starts_with(b"%PDF-"))
        .and_then(|b| {
            let count = lopdf::Document::load_mem(&b).ok()?.get_pages().len() as u32;
            (count > 0).then_some((b, count))
        });
    let (pdf, count) = match cached {
        Some(hit) => hit,
        None => {
            let bytes = volume_bytes(id, &url).await?;
            let out = tokio::task::spawn_blocking(move || extract(bytes, from, to)).await??;
            tokio::fs::write(&slice_path, &out.0).await?;
            out
        }
    };
    let dir = crate::downloads::download_root()?.join("培养方案");
    std::fs::create_dir_all(&dir)?;
    let name = format!(
        "{} {}（{} 第{}-{}页）.pdf",
        title_component(&volume_title, 40),
        title_component(title, 60),
        folder_component(id),
        from,
        from + count - 1
    );
    let path = dir.join(name);
    tokio::fs::write(&path, &pdf).await?;
    if open {
        crate::platform::open(path.as_os_str())?;
    }
    Ok(json!({
        "pdf": base64::engine::general_purpose::STANDARD.encode(&pdf),
        "path": path.to_string_lossy(),
        "pages": count,
        "volume": volume_title,
        "url": url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;
    #[test]
    fn titles_truncate_at_character_boundaries() {
        let title = "中文培养方案😀".repeat(20);
        for limit in [40, 60] {
            let part = title_component(&title, limit);
            assert!(part.len() <= limit && part.len() + 4 > limit);
            assert!(title.starts_with(&part));
        }
        assert_eq!(title_component("a/b:c", 60), "a_b_c");
    }
    #[test]
    fn volumes_manifest_is_readable_and_pku_only() {
        let (title, url) = volume("2025-理科").unwrap();
        assert!(title.contains("2025"));
        assert!(url.starts_with("https://dean.pku.edu.cn/"));
        assert!(volume("2099-理科").is_err());
    }
    #[test]
    fn extract_keeps_only_requested_pages() {
        let mut doc = lopdf::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = vec![];
        for _ in 0..5 {
            let content = doc.add_object(lopdf::Stream::new(lopdf::dictionary! {}, vec![]));
            let page = doc.add_object(lopdf::dictionary! {
                "Type" => "Page", "Parent" => pages_id, "Contents" => content,
            });
            kids.push(lopdf::Object::Reference(page));
        }
        let count = kids.len() as u32;
        doc.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages", "Kids" => kids, "Count" => count,
            }),
        );
        let catalog =
            doc.add_object(lopdf::dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let (out, n) = extract(bytes.clone(), 2, 3).unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            lopdf::Document::load_mem(&out).unwrap().get_pages().len(),
            2
        );
        assert!(extract(bytes, 9, 9).is_err());
    }
}
