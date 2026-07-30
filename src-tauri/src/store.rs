//! On-disk and in-keychain persistence.
//!
//! Three distinct things get stored, deliberately in three different places:
//!
//! | What            | Where                          | Why |
//! |-----------------|--------------------------------|-----|
//! | `api_hash`      | OS keychain                    | It is a credential. §10.1. |
//! | `api_id`        | settings file                  | Not secret — it is a public app identifier. |
//! | MTProto session | `telewire.session` (SQLite)    | grammers 0.10 owns this file; see note below. |
//! | Settings        | `settings.json`                | Plain preferences, nothing sensitive. |
//!
//! **Deviation from Plan.md §10, recorded deliberately.** The plan assumes a
//! session *string* that can be encrypted and dropped into the keychain.
//! grammers 0.10 removed that: `Session` is a trait, and the only persistent
//! implementation is `SqliteSession`, which writes through to a SQLite file on
//! every mutation and exposes no serialise/deserialise path. There is no
//! string to put in a keychain. What we can still honour is the *intent*:
//! the file is created inside the per-user app-data directory and tightened to
//! owner-only permissions, and the auth key never passes through our code, our
//! logs, or the IPC bridge.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use crate::model::Settings;

const KEYRING_SERVICE: &str = "app.telewire.desktop";
const KEYRING_USER: &str = "api_hash";

/// Resolve (and create) the per-user data directory, e.g.
/// `%APPDATA%/TeleWire`, `~/Library/Application Support/TeleWire`,
/// `~/.local/share/TeleWire`.
pub fn data_dir() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .context("no user data directory on this platform")?
        .join("TeleWire");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("could not create {}", dir.display()))?;
    Ok(dir)
}

pub fn session_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("telewire.session"))
}

fn settings_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

/// Best-effort owner-only permissions (§10). On Unix this is a real chmod; on
/// Windows the containing per-user AppData directory already carries an ACL
/// that excludes other users, and tightening the file further would require
/// hand-rolling a DACL for no additional protection.
pub fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/* ------------------------------------------------------------ credentials */

/// `api_id` is not a secret (it identifies the app, not the user), so it lives
/// beside the settings. `api_hash` is, and goes to the OS keychain.
#[derive(Debug, Clone)]
pub struct Credentials {
    pub api_id: i32,
    pub api_hash: String,
}

fn keyring_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .context("could not open the system keychain")
}

/// Credentials baked in at compile time, if whoever built this binary supplied
/// them:
///
/// ```sh
/// TELEWIRE_API_ID=1234567 TELEWIRE_API_HASH=abc… npm run bundle
/// ```
///
/// This is the difference between "sign in with your phone number" and "first
/// go and register an application". A binary built with these set never shows
/// the credentials screen at all.
///
/// It is deliberately *not* a checked-in default. Plan.md §6.5 rules out
/// shipping shared credentials in a public repo, and Telegram enforces the
/// same thing from the other side: an api_id that shows up in a public
/// codebase gets `API_ID_PUBLISHED_FLOOD` and stops working for everyone using
/// it. So the repo stays clean, and each distributor supplies their own.
fn embedded_credentials() -> Option<Credentials> {
    let id = option_env!("TELEWIRE_API_ID")?.trim();
    let hash = option_env!("TELEWIRE_API_HASH")?.trim();
    if id.is_empty() || hash.is_empty() {
        return None;
    }
    Some(Credentials {
        api_id: id.parse().ok()?,
        api_hash: hash.to_owned(),
    })
}

// No `has_embedded_credentials()` helper is needed: `load_credentials()`
// already returns them, so a build that carries credentials simply never
// produces `AuthState::NeedsCredentials` and the UI opens on the phone screen.

pub fn save_credentials(api_id: i32, api_hash: &str) -> Result<()> {
    keyring_entry()?
        .set_password(api_hash)
        .context("could not write the API hash to the system keychain")?;

    let mut stored = load_stored()?;
    stored.api_id = Some(api_id);
    write_stored(&stored)
}

pub fn load_credentials() -> Result<Option<Credentials>> {
    // Anything the user entered themselves wins, so a build with embedded
    // credentials can still be pointed at a personal registration.
    let Some(api_id) = load_stored()?.api_id else {
        return Ok(embedded_credentials());
    };
    let api_hash = match keyring_entry()?.get_password() {
        Ok(hash) => hash,
        // A missing keychain entry is a normal "not set up yet" state, not an
        // error worth surfacing — e.g. the settings file survived but the
        // keychain item was revoked. Fall back to whatever the build carries.
        Err(keyring::Error::NoEntry) => return Ok(embedded_credentials()),
        Err(e) => return Err(anyhow::anyhow!(e)).context("could not read the API hash"),
    };
    Ok(Some(Credentials { api_id, api_hash }))
}

/// Forget the API hash entirely. Not reachable from the UI today: signing out
/// deliberately keeps the app registration, and there is no "forget this
/// install" affordance yet. Kept because deleting the keychain item is the one
/// operation a user might reasonably need to perform and shouldn't have to do
/// with a keychain editor.
#[allow(dead_code)]
pub fn clear_credentials() -> Result<()> {
    if let Ok(entry) = keyring_entry() {
        // Deleting an absent entry is not a failure worth propagating.
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// Remove the MTProto session so the next launch starts unauthenticated.
pub fn clear_session() -> Result<()> {
    let path = session_path()?;
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{}", path.display(), suffix));
        if p.exists() {
            std::fs::remove_file(&p)
                .with_context(|| format!("could not remove {}", p.display()))?;
        }
    }
    Ok(())
}

/* -------------------------------------------------------------- settings */

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct Stored {
    api_id: Option<i32>,
    #[serde(default)]
    settings: Option<Settings>,
}

fn load_stored() -> Result<Stored> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Stored::default());
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read {}", path.display()))?;
    // A corrupt settings file should not brick the app; fall back to defaults
    // rather than refusing to start.
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

fn write_stored(stored: &Stored) -> Result<()> {
    let path = settings_path()?;
    let text = serde_json::to_string_pretty(stored)?;
    std::fs::write(&path, text)
        .with_context(|| format!("could not write {}", path.display()))?;
    restrict_permissions(&path);
    Ok(())
}

pub fn load_settings() -> Settings {
    load_stored()
        .ok()
        .and_then(|s| s.settings)
        .unwrap_or_default()
        .sanitized()
}

pub fn save_settings(settings: &Settings) -> Result<Settings> {
    let clean = settings.clone().sanitized();
    let mut stored = load_stored()?;
    stored.settings = Some(clean.clone());
    write_stored(&stored)?;
    Ok(clean)
}
