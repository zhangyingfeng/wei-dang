use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

// Matches src/index.ts's listen(app, 4417) call — see docs/DESIGN.md for why
// this doesn't match zhi-dang's 4317/4318: a stray zhi-dang dev server left
// running on this machine must never end up talking to this app's window.
const APP_URL: &str = "http://127.0.0.1:4417";
const WEIXIN_LOGIN_URL: &str = "https://mp.weixin.qq.com/";

/// Creates the main window pointed at the local Express server. In `tauri
/// dev` that server is already running (started by `beforeDevCommand`).
///
/// Release packaging (a compiled sidecar binary the app spawns itself, so a
/// packaged .app doesn't depend on `npm run dev` still running) isn't set up
/// yet — see docs/DESIGN.md. For now this always points at the dev server,
/// so only `npm run tauri dev` actually works end to end.
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
  let url = APP_URL.parse().expect("APP_URL is a valid URL");
  WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
    .title("微档")
    .inner_size(760.0, 460.0)
    // The window's height is always kept in sync with the page's actual
    // rendered content via `resize_main_window` (see app.js's
    // `resizeToContent`). Letting the user drag-resize it independently
    // would desync the two and either clip content (scrollbar) or leave
    // dead space, so resizing is programmatic only.
    .resizable(false)
    .build()?;
  Ok(())
}

/// Creates the embedded public-account login window up front, hidden, so its
/// page context is already live when the app checks for an existing session
/// on startup (see `check_login_status`) — not just after the user clicks
/// "开始登录".
fn create_login_window(app: &tauri::AppHandle) -> tauri::Result<()> {
  let url = WEIXIN_LOGIN_URL.parse().expect("WEIXIN_LOGIN_URL is a valid URL");
  WebviewWindowBuilder::new(app, "login", WebviewUrl::External(url))
    .title("微档 - 登录公众号")
    .visible(false)
    .inner_size(1000.0, 760.0)
    .min_inner_size(760.0, 560.0)
    .build()?;
  Ok(())
}

/// Builds the default menu bar, but swaps the standard "About <App>" item for
/// a custom one (id `show-about`) that the frontend can respond to with its
/// own about panel instead of macOS's built-in dialog — see `on_menu_event`
/// in `run()`. Everything else (Edit's cut/copy/paste, Window, etc.) stays
/// exactly as `Menu::default` provides, since re-deriving those by hand would
/// silently lose standard shortcut behavior.
fn build_menu_with_custom_about(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
  let menu = Menu::default(app)?;
  if let Some(MenuItemKind::Submenu(app_submenu)) = menu.items()?.into_iter().next() {
    let items = app_submenu.items()?;
    let about_position = items.iter().position(|item| {
      matches!(
        item,
        MenuItemKind::Predefined(p) if p.text().map(|t| t.contains("About")).unwrap_or(false)
      )
    });
    if let Some(pos) = about_position {
      app_submenu.remove_at(pos)?;
      let about_item = MenuItemBuilder::with_id("show-about", "关于微档").build(app)?;
      app_submenu.insert(&about_item, pos)?;
    }
  }
  Ok(menu)
}

/// Grows (or shrinks) the main window's height to fit the current step, while
/// preserving whatever width the user has resized it to.
#[tauri::command]
fn resize_main_window(app: tauri::AppHandle, height: f64) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("main") {
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let current = win.inner_size().map_err(|e| e.to_string())?;
    let width = current.width as f64 / scale;
    win
      .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[derive(Default)]
struct PendingFetches {
  next_id: AtomicU64,
  senders: Mutex<HashMap<u64, oneshot::Sender<(u16, String)>>>,
}

/// Shows and focuses the embedded login window. The window itself is
/// created once, hidden, at startup (`create_login_window`) — this just
/// brings it forward; the `build()` fallback below only matters if that
/// initial creation somehow failed.
#[tauri::command]
fn open_login_window(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("login") {
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    return Ok(());
  }
  let url = WEIXIN_LOGIN_URL
    .parse()
    .map_err(|e: url::ParseError| e.to_string())?;
  WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
    .title("微档 - 登录公众号")
    .inner_size(1000.0, 760.0)
    .min_inner_size(760.0, 560.0)
    .build()
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// Hides the login window (used by the in-page "close this window" button).
///
/// This deliberately hides rather than destroys the window: every later
/// backend API call runs as `fetch()` inside this window's own page context
/// (see `do_weixin_fetch`), so the window — and the token-bearing session
/// living in its page — has to stay alive for the lifetime of the app, even
/// though the user just wants it out of the way.
#[tauri::command]
fn close_login_window(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("login") {
    win.hide().map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Reads the login window's current URL and pulls the `token` query param
/// off it, but only once that URL is actually the post-login admin home page
/// (`/cgi-bin/home`) — this is the one place a real session token exists
/// (see WeixinSession's doc comment in src/source/weixin.ts): unlike Zhihu,
/// there's no `/me`-style endpoint to probe, so login success is detected by
/// which page the login window has navigated itself to after a successful
/// QR-code scan, not by a fetch response.
fn current_token(app: &tauri::AppHandle) -> Option<String> {
  let win = app.get_webview_window("login")?;
  let url = win.url().ok()?;
  if url.host_str() != Some("mp.weixin.qq.com") || url.path() != "/cgi-bin/home" {
    return None;
  }
  url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned())
}

/// Runs `fetch(url)` inside the login window's own page context (so the
/// backend sees a normal same-origin, cookie-bearing request) and awaits the
/// result back in Rust via IPC.
async fn do_weixin_fetch(
  app: &tauri::AppHandle,
  state: &PendingFetches,
  url: &str,
) -> Result<(u16, String), String> {
  let win = app
    .get_webview_window("login")
    .ok_or_else(|| "登录窗口不存在，请先打开登录窗口".to_string())?;
  let id = state.next_id.fetch_add(1, Ordering::SeqCst);
  let (tx, rx) = oneshot::channel();
  state.senders.lock().unwrap().insert(id, tx);

  let url_json = serde_json::to_string(url).map_err(|e| e.to_string())?;
  let script = format!(
    r#"(async () => {{
      try {{
        const r = await fetch({url_json}, {{
          headers: {{ accept: "application/json, text/plain, */*" }},
          credentials: "include"
        }});
        const body = await r.text();
        await window.__TAURI__.core.invoke("weixin_fetch_result", {{ id: {id}, status: r.status, body }});
      }} catch (e) {{
        await window.__TAURI__.core.invoke("weixin_fetch_result", {{ id: {id}, status: 0, body: String(e) }});
      }}
    }})();"#
  );
  win.eval(&script).map_err(|e| e.to_string())?;

  match tokio::time::timeout(Duration::from_secs(30), rx).await {
    Ok(Ok(result)) => Ok(result),
    Ok(Err(_)) => Err("登录窗口没有返回结果（可能已关闭）".to_string()),
    Err(_) => {
      state.senders.lock().unwrap().remove(&id);
      Err("请求公众号接口超时".to_string())
    }
  }
}

#[tauri::command]
async fn weixin_fetch(
  app: tauri::AppHandle,
  state: tauri::State<'_, PendingFetches>,
  url: String,
) -> Result<(u16, String), String> {
  do_weixin_fetch(&app, &state, &url).await
}

/// Called back from the page-context fetch script to deliver its result.
#[tauri::command]
fn weixin_fetch_result(state: tauri::State<'_, PendingFetches>, id: u64, status: u16, body: String) {
  if let Some(tx) = state.senders.lock().unwrap().remove(&id) {
    let _ = tx.send((status, body));
  }
}

/// Called once on startup to detect whether the login window already holds
/// a valid token, so the app can skip the login step entirely on repeat
/// launches. Retries briefly to cover the window where the (hidden) login
/// window's page is still loading right after app start.
#[tauri::command]
async fn check_login_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  const ATTEMPTS: u32 = 6;
  for attempt in 0..ATTEMPTS {
    if let Some(token) = current_token(&app) {
      return Ok(serde_json::json!({ "loggedIn": true, "token": token }));
    }
    if attempt + 1 < ATTEMPTS {
      tokio::time::sleep(Duration::from_millis(400)).await;
    }
  }
  Ok(serde_json::json!({ "loggedIn": false }))
}

/// Polls the login window until it has navigated to the post-login admin
/// home page with a token in the URL, then shows a "you can close this
/// window" banner inside it.
#[tauri::command]
async fn wait_for_login(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
  loop {
    if app.get_webview_window("login").is_none() {
      return Err("登录窗口已关闭，请重新点击登录。".to_string());
    }
    if let Some(token) = current_token(&app) {
      if let Some(win) = app.get_webview_window("login") {
        let banner = r#"(() => {
          if (document.getElementById('wd-login-ok')) return;
          const b = document.createElement('div');
          b.id = 'wd-login-ok';
          b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#1a7f37;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:center;gap:14px;font:600 15px -apple-system,sans-serif;z-index:2147483647;';
          const text = document.createElement('span');
          text.textContent = '登录成功，可以关闭此窗口';
          const btn = document.createElement('button');
          btn.textContent = '关闭窗口';
          btn.style.cssText = 'background:#fff;color:#1a7f37;border:0;border-radius:6px;padding:8px 14px;font:600 14px -apple-system,sans-serif;cursor:pointer;';
          btn.onclick = () => window.__TAURI__.core.invoke('close_login_window');
          b.appendChild(text);
          b.appendChild(btn);
          document.body.prepend(b);
        })();"#;
        let _ = win.eval(banner);
      }
      return Ok(serde_json::json!({ "token": token }));
    }
    if tokio::time::Instant::now() >= deadline {
      return Err("等待登录超时，请重新点击登录。".to_string());
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
  }
}

/// Clears the login window's session (cookies, storage, etc.) so the next
/// login starts fresh, and navigates it back to the QR login page.
#[tauri::command]
fn logout(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("login") {
    win.clear_all_browsing_data().map_err(|e| e.to_string())?;
    let url = WEIXIN_LOGIN_URL
      .parse()
      .map_err(|e: url::ParseError| e.to_string())?;
    win.navigate(url).map_err(|e| e.to_string())?;
    win.hide().map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      let menu = build_menu_with_custom_about(app.handle())?;
      app.set_menu(menu)?;
      app.on_menu_event(|app, event| {
        if *event.id() == "show-about" {
          if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("show-about", ());
          }
        }
      });
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      create_main_window(app.handle())?;
      create_login_window(app.handle())?;
      Ok(())
    })
    .manage(PendingFetches::default())
    .invoke_handler(tauri::generate_handler![
      open_login_window,
      close_login_window,
      weixin_fetch,
      weixin_fetch_result,
      wait_for_login,
      resize_main_window,
      logout,
      check_login_status
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");
  app.run(|_app_handle, _event| {});
}
