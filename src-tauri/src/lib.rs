use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

// Matches src/index.ts's listen(app, 4417) call — see docs/DESIGN.md for why
// this doesn't match zhi-dang's 4317/4318: a stray zhi-dang dev server left
// running on this machine must never end up talking to this app's window.
const APP_URL: &str = "http://127.0.0.1:4417";
const WEIXIN_LOGIN_URL: &str = "https://mp.weixin.qq.com/";

/// Creates the main window pointed at the local Express server. In `tauri
/// dev` that server is already running (started by `beforeDevCommand`); in a
/// release build we spawn it ourselves first as a sidecar (see
/// `spawn_backend_sidecar`) — either way it ends up listening on the same
/// `APP_URL`.
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

/// Holds the sidecar's process handle so it can be killed on app exit (see
/// `kill_backend_sidecar`). Without this, `CommandChild::kill` is never
/// reachable and the sidecar — spawned via `tauri_plugin_shell`, which does
/// NOT tie the child's lifetime to the parent app — outlives a normal quit,
/// gets reparented to launchd, and keeps holding its port. A later launch's
/// window can then silently end up talking to that stale process instead of
/// its own fresh one.
#[derive(Default)]
struct SidecarProcess(Mutex<Option<CommandChild>>);

fn spawn_backend_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  let resource_dir = app.path().resource_dir()?;
  let public_dir = resource_dir.join("public");
  let sidecar = app
    .shell()
    .sidecar("weidang-server")?
    .env("WEIDANG_PUBLIC_DIR", public_dir.to_string_lossy().to_string());
  let (mut events, child) = sidecar.spawn()?;
  if let Some(state) = app.try_state::<SidecarProcess>() {
    *state.0.lock().unwrap() = Some(child);
  }
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      if let tauri_plugin_shell::process::CommandEvent::Stderr(line) = event {
        eprintln!("[server] {}", String::from_utf8_lossy(&line));
      }
    }
  });
  Ok(())
}

/// Kills the sidecar spawned by `spawn_backend_sidecar`, if any is still
/// running. Called from the `RunEvent::Exit` handler in `run()` so the
/// server process doesn't outlive the app.
///
/// This hooks `Exit`, not the seemingly more obvious `ExitRequested`: a
/// normal macOS quit never emits `ExitRequested` at all (verified in
/// zhi-dang, which shares this exact pattern) — the event loop goes
/// straight from `MainEventsCleared` to `Exit`.
fn kill_backend_sidecar(app: &tauri::AppHandle) {
  if let Some(state) = app.try_state::<SidecarProcess>() {
    if let Some(child) = state.0.lock().unwrap().take() {
      let _ = child.kill();
    }
  }
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

/// Hides the login window — called from app.js the instant `wait_for_login`
/// resolves, since the 1000x760 login window otherwise sits on top of the
/// much smaller main window and hides the download step it just unlocked.
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
  // Hiding the login window doesn't reliably hand focus back to the main
  // window on its own — without this, macOS can leave the app inactive (or
  // focus whatever window was behind the login window before it existed),
  // so the just-unblocked download step still isn't the thing the user
  // actually sees.
  if let Some(win) = app.get_webview_window("main") {
    win.set_focus().map_err(|e| e.to_string())?;
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
/// home page with a token in the URL. The caller (app.js) closes the login
/// window itself the moment this resolves — see close_login_window's doc
/// comment — so there's no in-window banner here to prompt a manual close;
/// by the time anyone could read one, the window would already be gone.
#[tauri::command]
async fn wait_for_login(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
  loop {
    if app.get_webview_window("login").is_none() {
      return Err("登录窗口已关闭，请重新点击登录。".to_string());
    }
    if let Some(token) = current_token(&app) {
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
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      app.manage(SidecarProcess::default());
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
        create_main_window(app.handle())?;
      } else {
        spawn_backend_sidecar(app.handle())?;
        create_main_window(app.handle())?;
      }
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
  app.run(|app_handle, event| {
    if let RunEvent::Exit = event {
      kill_backend_sidecar(app_handle);
    }
  });
}
