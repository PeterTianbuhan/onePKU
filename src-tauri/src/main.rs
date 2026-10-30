#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::Manager;
mod browser;
mod haoxue;
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
/// 两个更新通道：稳定版跟 GitHub 上最新的正式 Release，每日构建跟固定的 nightly 预发布。
const STABLE_FEED: &str =
    "https://github.com/PeterTianbuhan/onePKU/releases/latest/download/latest.json";
const NIGHTLY_FEED: &str =
    "https://github.com/PeterTianbuhan/onePKU/releases/download/nightly/latest.json";

/// 按通道检查更新，返回与更新插件 `check()` 相同的结构，前端照旧用插件的 Update 下载安装。
/// 稳定通道上，正在用每日构建（版本号带预发布后缀）时，只要稳定版不同就提供，
/// 这样从每日构建切回稳定版时会装回当前稳定版，哪怕版本号更低。
#[tauri::command]
async fn check_update(
    window: tauri::WebviewWindow,
    channel: String,
) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_updater::UpdaterExt;
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let feed = match channel.as_str() {
        "stable" => STABLE_FEED,
        "nightly" => NIGHTLY_FEED,
        _ => return Err("未知的更新通道".into()),
    };
    let mut builder = window
        .updater_builder()
        .endpoints(vec![feed.parse().map_err(|_| "更新地址无效")?])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(20));
    if channel == "stable" {
        builder = builder.version_comparator(|current, remote| {
            if current.pre.is_empty() {
                remote.version > current
            } else {
                remote.version != current
            }
        });
    }
    let update = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|update| {
        serde_json::json!({
            "currentVersion": update.current_version,
            "version": update.version,
            "date": update.raw_json.get("pub_date").and_then(|d| d.as_str()),
            "body": update.body,
            "rawJson": update.raw_json,
            "rid": window.resources_table().add(update),
        })
    }))
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
async fn choose_download_folder(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<campus_core::Core>>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let selected = rfd::AsyncFileDialog::new()
        .set_title("选择 OnePKU 保存下载与资料的文件夹")
        .pick_folder()
        .await;
    let Some(folder) = selected else {
        return Ok(None);
    };
    let path = folder.path().to_path_buf();
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.set_download_root(&path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "未能保存所选文件夹".to_string())?
}
#[tauri::command]
async fn choose_cache_folder(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<campus_core::Core>>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let selected = rfd::AsyncFileDialog::new()
        .set_title("选择 OnePKU 存放回放缓存的文件夹")
        .pick_folder()
        .await;
    let Some(folder) = selected else {
        return Ok(None);
    };
    let path = folder.path().to_path_buf();
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.set_cache_root(&path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "未能保存所选文件夹".to_string())?
}
/// 原生窗口主题：页面切深色时标题栏与滚动条要一起变，不然一半深一半浅。
#[tauri::command]
async fn set_window_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    let value = match theme.as_str() {
        "dark" => tauri::utils::Theme::Dark,
        _ => tauri::utils::Theme::Light,
    };
    for (_, window) in app.webview_windows() {
        let _ = window.set_theme(Some(value));
    }
    Ok(())
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
        // 更新只从 check_update 里写死的两个 GitHub Release 地址取，并用内置公钥校验签名。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(campus_core::Core::new())
        .manage(browser::PortalNoticeReader::default())
        .setup(|app| {
            browser::install_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            campus,
            check_update,
            choose_assignment_file,
            choose_course_files,
            choose_download_folder,
            choose_cache_folder,
            set_window_theme,
            choose_subtitle_file,
            open_booking,
            browser::open_browser,
            haoxue::open_haoxue_login,
            haoxue::haoxue_login
        ])
        .run(tauri::generate_context!())
        .expect("OnePKU startup failed");
}
