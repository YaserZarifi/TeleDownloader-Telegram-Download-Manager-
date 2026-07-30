//! TeleWire — a Telegram download manager that runs entirely on your machine.
//!
//! There is no server, no bot, and no relay anywhere in this program. The Rust
//! side *is* a Telegram client (via `grammers`), so the only two parties ever
//! exchanging file bytes are Telegram's data centers and the local disk.

mod commands;
mod model;
mod store;
mod telegram;

use std::sync::Arc;
use tauri::Manager;

use commands::AppState;
use telegram::{download::Engine, Telegram};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The engine needs an `AppHandle` to emit progress, so both live
            // in managed state built here rather than in a global.
            let tg = Arc::new(Telegram::default());
            let engine = Engine::new(app.handle().clone(), Arc::clone(&tg));

            // Diagnostic mode: `TELEWIRE_PROBE=1` walks the account's chats and
            // reports what the media scanner actually sees in each, then exits.
            // Faster than clicking through the UI when a chat looks empty, and
            // it exercises exactly the code path the UI uses.
            if std::env::var("TELEWIRE_PROBE").as_deref() == Ok("1") {
                let tg = Arc::clone(&tg);
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = probe(&tg).await {
                        eprintln!("[telewire] probe failed: {e:#}");
                    }
                    std::process::exit(0);
                });
            }

            app.manage(AppState { tg, engine });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_auth_state,
            commands::save_credentials,
            commands::login_start,
            commands::login_submit_code,
            commands::login_submit_password,
            commands::logout,
            commands::list_dialogs,
            commands::resolve_channel,
            commands::get_chat_photo,
            commands::list_media,
            commands::enqueue_download,
            commands::pause_download,
            commands::resume_download,
            commands::cancel_download,
            commands::retry_download,
            commands::list_jobs,
            commands::clear_finished,
            commands::get_settings,
            commands::set_settings,
            commands::pick_directory,
            commands::reveal_in_folder,
            commands::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TeleWire");
}

/// Walk every chat and report what `list_media` finds, so an "empty" chat can
/// be diagnosed from a log rather than guessed at.
async fn probe(tg: &Arc<Telegram>) -> anyhow::Result<()> {
    use model::MediaFilter;

    let state = tg.state().await;
    eprintln!("[telewire] probe: auth={state:?}");

    let client = tg.client().await?;
    let dialogs = telegram::channel::list_dialogs(tg, &client).await?;
    eprintln!("[telewire] probe: {} chats", dialogs.len());

    for chat in dialogs.iter().take(25) {
        let Some(peer) = tg.peer(chat.id).await else { continue };
        eprintln!(
            "[telewire] probe: --- {:?} \"{}\" id={}",
            chat.kind, chat.title, chat.id
        );
        match telegram::channel::list_media(&client, peer, 0, 20, MediaFilter::All).await {
            Ok(page) => {
                let with_thumb = page.items.iter().filter(|i| i.thumb.is_some()).count();
                eprintln!(
                    "[telewire] probe:     thumbs {}/{}",
                    with_thumb,
                    page.items.len()
                );
                for item in page.items.iter().take(3) {
                    eprintln!(
                        "[telewire] probe:     {:?} {} ({} bytes) mime={} thumb={}",
                        item.kind,
                        item.name,
                        item.size,
                        item.mime,
                        item.thumb.as_ref().map(|t| t.len()).unwrap_or(0)
                    );
                }
            }
            Err(e) => eprintln!("[telewire] probe:     ERROR {e:#}"),
        }
    }
    Ok(())
}
