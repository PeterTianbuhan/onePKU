#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::Manager;
mod browser;
#[tauri::command]
async fn campus(
    window: tauri::WebviewWindow,
    request: campus_core::Request,
    state: tauri::State<'_, Arc<campus_core::Core>>,
) -> Result<campus_core::Envelope, String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.call(request))
        .await
        .map_err(|_| "服务暂不可用".into())
}
#[tauri::command]
async fn choose_assignment_file(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<campus_core::Core>>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let selected = rfd::AsyncFileDialog::new()
        .set_title("选择要提交的作业文件（最多 25 MB）")
        .pick_file()
        .await;
    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.stage_assignment_file(&path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "文件准备失败".to_string())?
}
#[tauri::command]
async fn choose_course_files(
    window: tauri::WebviewWindow,
    course: String,
    state: tauri::State<'_, Arc<campus_core::Core>>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let generation = campus_core::fingerprint("course");
    let selected = rfd::AsyncFileDialog::new()
        .set_title("添加课程资料（可多选）")
        .pick_files()
        .await;
    let Some(files) = selected else {
        return Ok(None);
    };
    let paths = files
        .into_iter()
        .map(|file| file.path().to_path_buf())
        .collect::<Vec<_>>();
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.import_course_files(&course, &generation, &paths)
            .map(Some)
            .map_err(|e| {
                e.to_string()
                    .trim_start_matches("LOCAL_MATERIAL:")
                    .trim()
                    .to_string()
            })
    })
    .await
    .map_err(|_| "资料添加失败，请重试".to_string())?
}
#[tauri::command]
async fn choose_subtitle_file(
    window: tauri::WebviewWindow,
    id: String,
    state: tauri::State<'_, Arc<campus_core::Core>>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("导入字幕 · SRT / VTT")
        // macOS may not register SRT/VTT file types. Validate the chosen extension in core.
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.import_subtitle(&id, &path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "字幕导入失败".to_string())?
}
#[tauri::command]
async fn open_booking(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    site: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let (title, url) = match site.as_str() {
        "sports" => ("体育场馆 · 学校原站", "https://epe.pku.edu.cn/venue/PKU"),
        "bdkj" => ("教学研讨 · 学校原站", "https://bdkj.pku.edu.cn/classRoom"),
        "library" => ("图书馆研讨室 · 学校原站", "https://kjyy.lib.pku.edu.cn/"),
        _ => return Err("预约系统无效".into()),
    };
    let label = format!("official-{site}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|_| "窗口无法显示")?;
        return existing.set_focus().map_err(|_| "窗口无法激活".into());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::External(url.parse().unwrap()),
    )
    .title(title)
    .inner_size(1120.0, 800.0)
    .min_inner_size(760.0, 600.0)
    .on_navigation(|url| {
        url.as_str() == "about:blank"
            || (url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|h| h == "pku.edu.cn" || h.ends_with(".pku.edu.cn")))
    })
    .build()
    .map_err(|_| "无法打开学校预约窗口")?;
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .manage(campus_core::Core::new())
        .manage(browser::PortalNoticeReader::default())
        .setup(|app| {
            browser::install_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            campus,
            choose_assignment_file,
            choose_course_files,
            choose_subtitle_file,
            open_booking,
            browser::open_browser
        ])
        .run(tauri::generate_context!())
        .expect("OnePKU startup failed");
}
