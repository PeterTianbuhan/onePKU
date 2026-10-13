//! 好学课堂实录登录窗口。与好学的实现同一条路径：用户在学校页面里完成统一认证
//! （密码只留在学校页面），浏览器落回中转页后，核心拿窗口里的会话 cookie、
//! 以安卓 WebView 身份重取中转页，从源码里解出令牌并写入私有会话。
//! 页面里注入的原生桥是备份通道：学校页面直接交出令牌时也能收。
use super::*;
use tauri::Emitter;

const LABEL: &str = "haoxue-login";
const LOGIN: &str = "https://passport.pku.edu.cn/auth/login?redirect=https%3A%2F%2Fpassport.pku.edu.cn%2Fauth%2Fapp-login";
const RELAY: &str = "https://passport.pku.edu.cn/auth/app-login";

/// 备份通道：中转页若主动调用 `bridge.PKULoginSuccess(payload)` 就直接收。
const BRIDGE: &str = r#"(function () {
  var relay = location.href.indexOf('https://passport.pku.edu.cn/auth/app-login') === 0;
  if (!relay) return;
  var internals = window.__TAURI_INTERNALS__;
  if (!internals || !internals.invoke) return;
  var bridge = {
    PKULoginSuccess: function (payload) {
      internals.invoke('haoxue_login', { payload: String(payload) }).catch(function () {});
    },
  };
  try {
    Object.defineProperty(window, 'bridge', {
      configurable: false,
      enumerable: true,
      get: function () { return bridge; },
      set: function () {},
    });
  } catch (error) {
    window.bridge = bridge;
  }
})();"#;

/// 认证页会把登录交给学校统一身份认证，两个域都要放行，否则跳转被拦下就是一片空白。
/// 只有 passport 的中转页会交出令牌，能力配置里的 remote.urls 仍只放 passport。
fn allowed_navigation(url: &tauri::Url) -> bool {
    // about:blank 必须放行：WebView2 在建窗口与重开时会先经过空白文档，
    // 拦掉它整个页面就再也起不来（浏览器原文窗口曾因此白屏）。
    if url.as_str() == "about:blank" {
        return true;
    }
    ["https://passport.pku.edu.cn/", "https://iaaa.pku.edu.cn/"]
        .iter()
        .any(|prefix| url.as_str().starts_with(prefix))
}

fn is_login_window(label: &str) -> bool {
    label.starts_with(LABEL)
}


fn settle(app: &tauri::AppHandle) {
    for (_, window) in app.webview_windows() {
        if is_login_window(window.label()) {
            let _ = window.close();
        }
    }
    // 登录窗口是自己关的，主界面不会知道：广播一次，让回放列表马上刷新。
    let _ = app.emit("haoxue-connected", ()).map_err(|_| ());
}

static NEXT_LOGIN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);

fn open(app: &tauri::AppHandle) -> Result<(), String> {
    // 新窗口用轮换标签先建起来，再关旧的：同名标签「关了马上建」会和还没走完的
    // 关闭流程撞车，建不出来就把人留在白屏里。
    let label = format!(
        "{LABEL}-{}",
        NEXT_LOGIN.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let window = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::External(LOGIN.parse().map_err(|_| "登录地址无效")?),
    )
    .title("课堂实录 · 统一身份认证")
    .inner_size(980.0, 760.0)
    .min_inner_size(620.0, 520.0)
    // 桥必须在地道脚本之前注入，否则中转页找不到 `bridge.PKULoginSuccess`。
    .initialization_script(BRIDGE)
    .on_navigation(allowed_navigation)
    .on_page_load(|window, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        let url = payload.url().clone();
        let app = window.app_handle().clone();
        if !url.as_str().starts_with(RELAY) {
            return;
        }
        // 落回中转页：取窗口里的会话 cookie，让核心以安卓身份重取这一页解令牌。
        // cookie 读取必须离开这个回调线程：WebView2 要把完成消息送回同一线程，
        // 在这里直接调 cookies_for_url 会把任务卡死在第一步。
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            let cookies = window
                .cookies_for_url(url.clone())
                .unwrap_or_default()
                .iter()
                .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
                .collect::<Vec<_>>();
            let core = app.state::<Arc<campus_core::Core>>().inner().clone();
            let settled = tauri::async_runtime::spawn_blocking(move || {
                let mut last = String::new();
                for attempt in 0..3 {
                    if attempt > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                    }
                    let envelope = core.call(campus_core::Request::HaoxueRelay {
                        url: url.to_string(),
                        cookies: cookies.clone(),
                    });
                    match envelope.error {
                        None => return None,
                        Some(problem) => last = problem.message,
                    }
                }
                Some(last)
            })
            .await;
            if matches!(settled, Ok(None)) {
                settle(&app);
            }
        });
    })
    .build()
    .map_err(|_| "无法打开课堂实录登录窗口")?;
    for (old_label, old) in app.webview_windows() {
        if old_label != label && is_login_window(&old_label) {
            let _ = old.close();
        }
    }
    window.set_focus().map_err(|_| "登录窗口无法激活")?;
    Ok(())
}

/// 必须是 async：同步命令在主线程执行，而建窗口又要等主线程，直接把自己锁死。
#[tauri::command]
pub(crate) async fn open_haoxue_login(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不可执行本地操作".into());
    }
    open(&window.app_handle().clone())
}

/// 只有本窗口的载荷可以写入会话；载荷原样交给核心解析与保存。
#[tauri::command]
pub(crate) async fn haoxue_login(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<campus_core::Core>>,
    payload: String,
) -> Result<(), String> {
    if !is_login_window(window.label()) {
        return Err("此窗口不可写入登录状态".into());
    }
    let core = state.inner().clone();
    let parsed = serde_json::from_str(&payload).unwrap_or(serde_json::Value::String(payload));
    let envelope = tauri::async_runtime::spawn_blocking(move || {
        core.call(campus_core::Request::HaoxueLogin { payload: parsed })
    })
    .await
    .map_err(|_| "服务暂不可用".to_string())?;
    if envelope.error.is_some() {
        return Err(
            envelope
                .error
                .map(|problem| problem.message)
                .unwrap_or_else(|| "登录未完成".to_string()),
        );
    }
    settle(&window.app_handle().clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_window_labels_rotate_but_stay_recognizable() {
        assert!(is_login_window("haoxue-login-3"));
        assert!(is_login_window("haoxue-login"));
        assert!(!is_login_window("reader-2"));
        assert!(!is_login_window("main"));
    }
    #[test]
    fn the_login_window_follows_the_unified_auth_redirect() {
        let ok = [
            "https://passport.pku.edu.cn/auth/login?redirect=x",
            "https://iaaa.pku.edu.cn/iaaa/oauth.jsp",
            "about:blank",
        ];
        let blocked = [
            "https://evil.test/auth/login",
            "https://passport.pku.edu.cn.evil.test/",
            "http://passport.pku.edu.cn/auth/login",
            "https://example.com/",
        ];
        for url in ok {
            assert!(allowed_navigation(&url.parse().unwrap()), "{url}");
        }
        for url in blocked {
            assert!(!allowed_navigation(&url.parse().unwrap()), "{url}");
        }
    }
}
