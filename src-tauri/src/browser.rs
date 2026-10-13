use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};
use tauri::{Manager, WebviewWindow};

static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(1);
const PORTAL_READER: &str = "reader-portal-notices";

#[derive(Default)]
pub struct PortalNoticeReader {
    pending: Mutex<Option<tauri::Url>>,
    loaded: AtomicBool,
}

fn portal_shell(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("portal.pku.edu.cn")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/portal2017/"
        && url.query().is_none()
}

fn portal_notice(url: &tauri::Url) -> bool {
    portal_shell(url)
        && url
            .fragment()
            .and_then(|f| f.strip_prefix("/schoolNoticeDetail/"))
            .is_some_and(|id| {
                !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())
            })
}

fn portal_login(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && (url.host_str() == Some("iaaa.pku.edu.cn")
            || (url.host_str() == Some("portal.pku.edu.cn")
                && url.path().starts_with("/portal2017/login")))
}

fn notice_hash_script(current: &tauri::Url, destination: &tauri::Url) -> Option<String> {
    if !portal_shell(current) || !portal_notice(destination) || current == destination {
        return None;
    }
    Some(format!(
        "window.location.hash = {};",
        serde_json::to_string(destination.fragment()?).ok()?
    ))
}

fn open_portal_notice(
    app: &tauri::AppHandle,
    destination: tauri::Url,
    title: &str,
) -> Result<(), String> {
    *app.state::<PortalNoticeReader>().pending.lock().unwrap() = Some(destination.clone());
    if let Some(window) = app.get_webview_window(PORTAL_READER) {
        let current = window.url().map_err(|_| "无法读取原文窗口地址")?;
        let loaded = app
            .state::<PortalNoticeReader>()
            .loaded
            .load(Ordering::Acquire);
        if !loaded || portal_login(&current) {
            // Keep an in-flight load or verification form. Its completion
            // will consume the newest requested notice from `pending`.
        } else if let Some(script) = notice_hash_script(&current, &destination) {
            // This is the portal's own SPA route. Keep its document, session
            // storage and loaded assets instead of booting another portal.
            window.eval(&script).map_err(|_| "通知未能打开，请重试")?;
            let state = app.state::<PortalNoticeReader>();
            let mut pending = state.pending.lock().unwrap();
            if pending.as_ref() == Some(&destination) {
                *pending = None;
            }
        } else if current != destination {
            window
                .navigate(destination)
                .map_err(|_| "通知未能打开，请重试")?;
        }
        // If verification is in progress, preserve the form. The page-load
        // callback applies the latest requested notice after normal login.
        window.show().map_err(|_| "窗口无法显示")?;
        window.unminimize().map_err(|_| "窗口无法恢复")?;
        return window.set_focus().map_err(|_| "窗口无法激活".into());
    }
    let window = reader_with_label(app, destination, title, Some(PORTAL_READER))?;
    let retained = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            // Only one portal notice document is retained for this app run.
            // Quitting the app still ends the reader and its session storage.
            let _ = retained.hide();
            if let Some(main) = retained.app_handle().get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
    });
    Ok(())
}

fn web_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|h| h.contains('.') && h != "ipc.localhost" && !h.ends_with(".localhost"))
}

fn reader(app: &tauri::AppHandle, url: tauri::Url, title: &str) -> Result<WebviewWindow, String> {
    reader_with_label(app, url, title, None)
}

fn reader_with_label(
    app: &tauri::AppHandle,
    url: tauri::Url,
    title: &str,
    retained_label: Option<&str>,
) -> Result<WebviewWindow, String> {
    if !web_url(&url) {
        return Err("无法在原文窗口打开这个地址".into());
    }
    let course_cookies = if url.scheme() == "https" && url.host_str() == Some("course.pku.edu.cn") {
        app.state::<std::sync::Arc<campus_core::Core>>()
            .course_browser_cookies(url.as_str())
            .ok()
    } else {
        None
    };
    let destination = url.clone();
    let initial = if course_cookies.is_some() {
        "about:blank".parse().unwrap()
    } else {
        url
    };
    let popup_app = app.clone();
    let is_portal_reader = retained_label == Some(PORTAL_READER);
    let window = tauri::WebviewWindowBuilder::new(
        app,
        retained_label
            .map(str::to_string)
            .unwrap_or_else(|| format!("reader-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed))),
        tauri::WebviewUrl::External(initial),
    )
    .title(format!(
        "{} · OnePKU",
        title.chars().take(100).collect::<String>()
    ))
    .inner_size(1120.0, 820.0)
    .min_inner_size(760.0, 600.0)
    .on_navigation(|url| web_url(url) || url.as_str() == "about:blank")
    .on_page_load(move |window, payload| {
        if is_portal_reader {
            window
                .app_handle()
                .state::<PortalNoticeReader>()
                .loaded
                .store(
                    payload.event() == tauri::webview::PageLoadEvent::Finished,
                    Ordering::Release,
                );
        }
        if is_portal_reader
            && payload.event() == tauri::webview::PageLoadEvent::Finished
            && portal_shell(payload.url())
        {
            let destination = window
                .app_handle()
                .state::<PortalNoticeReader>()
                .pending
                .lock()
                .unwrap()
                .take();
            if let Some(destination) = destination {
                if let Some(script) = notice_hash_script(payload.url(), &destination) {
                    let _ = window.eval(&script);
                }
            }
        }
    })
    .on_document_title_changed(|window, title| {
        let host = window
            .url()
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let _ = window.set_title(&format!(
            "{} · {} · OnePKU",
            title.chars().take(90).collect::<String>(),
            host
        ));
    })
    .on_new_window(
        move |url, _features| match reader(&popup_app, url, "原文") {
            Ok(window) => tauri::webview::NewWindowResponse::Create { window },
            Err(_) => tauri::webview::NewWindowResponse::Deny,
        },
    )
    .build()
    .map_err(|_| "原文窗口未能打开，请重试".to_string())?;
    if let Some(cookies) = course_cookies {
        // Copy only target-matching cookies into the native cookie store. Values
        // never enter JavaScript; narrow parent-domain cookies to this host.
        for cookie in window
            .cookies_for_url(destination.clone())
            .unwrap_or_default()
        {
            // Preserve the website's non-authentication preferences, including
            // its already-acknowledged first-visit notice.
            if cookie.http_only() == Some(true)
                || cookies
                    .iter()
                    .any(|incoming| incoming.name == cookie.name())
            {
                let _ = window.delete_cookie(cookie);
            }
        }
        for cookie in cookies {
            window
                .set_cookie(
                    tauri::webview::Cookie::build((cookie.name, cookie.value))
                        .domain("course.pku.edu.cn")
                        .path(cookie.path)
                        .secure(true)
                        .http_only(cookie.http_only)
                        .build(),
                )
                .map_err(|_| "教学网会话未能载入，请重新打开原文".to_string())?;
        }
        window
            .navigate(destination)
            .map_err(|_| "原文未能打开".to_string())?;
    }
    Ok(window)
}

#[tauri::command]
pub async fn open_browser(
    app: tauri::AppHandle,
    window: WebviewWindow,
    url: Option<String>,
    target: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    // Remote pages have no local command authority or app capabilities.
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    let address = if let Some(target) = target {
        campus_core::official_target(&target)
            .map_err(|_| "原站地址无效")?
            .to_string()
    } else {
        url.ok_or("原站地址缺失")?
    };
    if address.len() > 8192 {
        return Err("原站地址过长".into());
    }
    let url = address.parse().map_err(|_| "原站地址无效")?;
    if portal_notice(&url) {
        return open_portal_notice(&app, url, title.as_deref().unwrap_or("原文"));
    }
    reader(&app, url, title.as_deref().unwrap_or("原文"))?;
    Ok(())
}

/// Windows 与 Linux 不装菜单栏：那条横条里只有系统菜单，桌面端用不上，还白占一行高度。
/// Tauri 只在 macOS 生成默认菜单，所以非 macOS 什么都不设就不会有横条。
pub fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return macos_menu(app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// macOS 的应用菜单在屏幕顶部，是「关于/退出」与网页快捷键的入口，不能省。
/// 只留应用、编辑与网页三项：默认菜单里的 File/View/Window/Help 是多余的横条。
#[cfg(target_os = "macos")]
fn macos_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let app_menu = Submenu::with_items(
        app,
        "OnePKU",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 OnePKU"), None)?,
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::hide(app, Some("隐藏"))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::show_all(app, Some("显示全部"))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("退出 OnePKU"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let page_menu = Submenu::with_items(
        app,
        "网页",
        true,
        &[
            &MenuItem::with_id(app, "reader-back", "后退", true, Some("CmdOrCtrl+["))?,
            &MenuItem::with_id(app, "reader-forward", "前进", true, Some("CmdOrCtrl+]"))?,
            &MenuItem::with_id(app, "reader-reload", "刷新网页", true, Some("CmdOrCtrl+R"))?,
        ],
    )?;
    let menu = Menu::new(app.handle())?;
    for item in [&app_menu, &edit_menu, &page_menu] {
        menu.append(item)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let Some(window) = app
            .webview_windows()
            .into_values()
            .find(|w| w.label().starts_with("reader-") && w.is_focused().unwrap_or(false))
        else {
            return;
        };
        match event.id().as_ref() {
            "reader-back" => {
                let _ = window.eval("history.back()");
            }
            "reader-forward" => {
                let _ = window.eval("history.forward()");
            }
            "reader-reload" => {
                let _ = window.reload();
            }
            _ => {}
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_only_the_official_portal_notice_route() {
        assert!(portal_notice(
            &"https://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/465743"
                .parse()
                .unwrap()
        ));
        for url in [
            "http://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/465743",
            "https://portal.pku.edu.cn.evil.test/portal2017/#/schoolNoticeDetail/465743",
            "https://user@portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/465743",
            "https://portal.pku.edu.cn:444/portal2017/#/schoolNoticeDetail/465743",
            "https://portal.pku.edu.cn/portal2017/?redirect=elsewhere#/schoolNoticeDetail/465743",
            "https://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/",
            "https://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/1/other",
            "https://course.pku.edu.cn/webapps/blackboard/execute/announcement",
        ] {
            assert!(!portal_notice(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn changes_only_the_fragment_of_an_existing_portal_document() {
        let target = "https://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/465743"
            .parse()
            .unwrap();
        let previous = "https://portal.pku.edu.cn/portal2017/#/schoolNoticeDetail/465700"
            .parse()
            .unwrap();
        assert_eq!(
            notice_hash_script(&previous, &target).as_deref(),
            Some("window.location.hash = \"/schoolNoticeDetail/465743\";")
        );
        assert!(notice_hash_script(&target, &target).is_none());
        for current in [
            "https://iaaa.pku.edu.cn/iaaa/oauth.jsp",
            "https://portal.pku.edu.cn/portal2017/login.jsp",
            "https://www.lib.pku.edu.cn/hdrl/index.htm",
        ] {
            assert!(notice_hash_script(&current.parse().unwrap(), &target).is_none());
        }
    }

    #[test]
    fn recognizes_verification_pages_without_treating_other_sites_as_login() {
        assert!(portal_login(
            &"https://iaaa.pku.edu.cn/iaaa/oauth.jsp?appID=portal"
                .parse()
                .unwrap()
        ));
        assert!(portal_login(
            &"https://portal.pku.edu.cn/portal2017/login.jsp"
                .parse()
                .unwrap()
        ));
        assert!(!portal_login(
            &"https://iaaa.pku.edu.cn.evil.test/iaaa/oauth.jsp"
                .parse()
                .unwrap()
        ));
        assert!(!portal_login(
            &"https://portal.pku.edu.cn/portal2017/".parse().unwrap()
        ));
    }
}
