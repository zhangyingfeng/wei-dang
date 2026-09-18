fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "open_login_window",
      "close_login_window",
      "weixin_fetch",
      "weixin_fetch_result",
      "wait_for_login",
      "check_login_status",
      "logout",
      "resize_main_window",
    ]),
  ))
  .expect("failed to run tauri-build");
}
