mod commands;
mod config;
mod logging;
mod models;
mod state;

use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = AppState::load()?;
            state.logger.add(
                "info",
                &format!(
                    "Heartopia 图片解密工具 {} 已启动；原始目录始终以只读方式访问。",
                    state.version
                ),
            );
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::set_directory,
            commands::select_recent,
            commands::auto_detect_input,
            commands::save_preferences,
            commands::scan_photos,
            commands::cancel_scan,
            commands::list_photos,
            commands::get_thumbnail,
            commands::start_decryption,
            commands::cancel_decryption,
            commands::get_logs,
            commands::open_logs_directory,
            commands::open_output_directory,
            commands::export_logs,
            commands::export_failures,
            commands::record_filter,
            commands::check_update,
            commands::install_update,
            commands::restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("Heartopia Photo Tool failed to start");
}
