use std::path::Path;

/// Bake the Telegram *application* credentials into the binary so end users
/// only ever type a phone number.
///
/// To be clear about what these are, because the naming misleads: `api_id` /
/// `api_hash` identify the **app**, not the account. Telegram Desktop has a
/// pair too. They are not bot credentials and they do not change whose account
/// signs in — TeleWire always signs in as an ordinary user via phone + code,
/// exactly like the official client. They are simply required before any
/// MTProto connection can be opened at all, which is why they cannot be
/// deferred until after the phone number.
///
/// Credentials are read from, in order:
///   1. the `TELEWIRE_API_ID` / `TELEWIRE_API_HASH` environment variables
///   2. `src-tauri/telewire.credentials` — a gitignored local file
///
/// If neither is present the app falls back to asking the user once, and
/// stores what they enter in the OS keychain.
///
/// The file is gitignored rather than committed on purpose: an `api_id` that
/// appears in a public repository earns `API_ID_PUBLISHED_FLOOD` from Telegram
/// and stops working for everyone using it (Plan.md §6.5).
fn main() {
    println!("cargo:rerun-if-env-changed=TELEWIRE_API_ID");
    println!("cargo:rerun-if-env-changed=TELEWIRE_API_HASH");
    println!("cargo:rerun-if-changed=telewire.credentials");

    let mut api_id = std::env::var("TELEWIRE_API_ID").unwrap_or_default();
    let mut api_hash = std::env::var("TELEWIRE_API_HASH").unwrap_or_default();

    if api_id.trim().is_empty() || api_hash.trim().is_empty() {
        if let Ok(text) = std::fs::read_to_string(Path::new("telewire.credentials")) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                // Tolerate quoting, since people paste these out of shells.
                let value = value.trim().trim_matches(['"', '\'']).to_owned();
                match key.trim() {
                    "TELEWIRE_API_ID" | "api_id" => api_id = value,
                    "TELEWIRE_API_HASH" | "api_hash" => api_hash = value,
                    _ => {}
                }
            }
        }
    }

    let api_id = api_id.trim();
    let api_hash = api_hash.trim();
    if !api_id.is_empty() && !api_hash.is_empty() && api_id.parse::<i32>().is_ok() {
        // `rustc-env` is what makes `option_env!` in store.rs see these.
        println!("cargo:rustc-env=TELEWIRE_API_ID={api_id}");
        println!("cargo:rustc-env=TELEWIRE_API_HASH={api_hash}");
        println!("cargo:warning=TeleWire: embedding app credentials — users will sign in with a phone number only.");
    } else {
        println!("cargo:warning=TeleWire: no app credentials embedded — users will be asked for an API ID and hash on first run. See src-tauri/telewire.credentials.example.");
    }

    tauri_build::build()
}
