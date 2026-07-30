//! Serde counterparts of `src/lib/types.ts`.
//!
//! Field names and enum tags here ARE the wire contract. Changing one without
//! changing `types.ts` produces a silent `undefined` in the UI rather than a
//! compile error, so both files carry a pointer to the other.

use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ auth */

#[derive(Debug, Clone, Serialize)]
pub struct TgUser {
    pub id: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub phone: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum AuthState {
    /// No api_id/api_hash stored on this machine yet.
    NeedsCredentials,
    /// Credentials known, but no authorised session.
    NeedsPhone { api_id: i32 },
    /// A login code has been sent to the user's other devices.
    NeedsCode {
        phone: String,
        code_length: Option<u32>,
    },
    /// Account has a cloud password.
    NeedsPassword { hint: Option<String> },
    /// Signed in.
    Ready { user: TgUser },
    /// Flow-level failure. `recoverable` means the same step can be retried;
    /// otherwise the UI restarts from the top.
    Error { message: String, recoverable: bool },
}

/* -------------------------------------------------------------- channels */

/// What kind of chat a rail entry is. Drives the rail's grouping, and it comes
/// from Telegram's own classification rather than an invented taxonomy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatKind {
    /// The signed-in account's own Saved Messages — where most people actually
    /// keep the files they care about, so it is surfaced first rather than
    /// filtered out as "a conversation with a user".
    Saved,
    /// Broadcast channel.
    Channel,
    /// Group or supergroup.
    Group,
    /// A bot conversation. Worth its own category because bots are a common
    /// way files arrive (upload bots, mirrors, converters).
    Bot,
    /// A one-to-one conversation with another person.
    Person,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelInfo {
    pub id: i64,
    pub title: String,
    pub username: Option<String>,
    pub participants: Option<i64>,
    /// Small inline data URI, or null. Never a remote URL — the webview is
    /// forbidden from making network requests.
    pub photo: Option<String>,
    pub broadcast: bool,
    pub kind: ChatKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaFilter {
    All,
    Video,
    Audio,
    Photo,
    Document,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Audio,
    Photo,
    Document,
}

impl MediaKind {
    /// Classify from MIME plus filename, because Telegram documents carry a
    /// MIME type that is often `application/octet-stream` for perfectly
    /// ordinary video files.
    pub fn classify(mime: &str, name: &str) -> Self {
        let m = mime.to_ascii_lowercase();
        if m.starts_with("video/") {
            return Self::Video;
        }
        if m.starts_with("audio/") {
            return Self::Audio;
        }
        if m.starts_with("image/") {
            return Self::Photo;
        }
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "mp4" | "mkv" | "avi" | "mov" | "webm" | "m4v" | "ts" | "flv" | "wmv" => Self::Video,
            "mp3" | "flac" | "m4a" | "ogg" | "opus" | "wav" | "aac" | "wma" => Self::Audio,
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "heic" | "avif" => Self::Photo,
            _ => Self::Document,
        }
    }

    pub fn matches(self, filter: MediaFilter) -> bool {
        match filter {
            MediaFilter::All => true,
            MediaFilter::Video => self == Self::Video,
            MediaFilter::Audio => self == Self::Audio,
            MediaFilter::Photo => self == Self::Photo,
            MediaFilter::Document => self == Self::Document,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaItem {
    pub message_id: i32,
    /// Chronological position in the channel, oldest = 1.
    pub seq: i64,
    pub name: String,
    pub mime: String,
    pub kind: MediaKind,
    pub size: u64,
    /// Unix seconds.
    pub date: i64,
    pub duration: Option<i64>,
    /// Tiny inline JPEG data URI reconstructed from the stripped thumbnail
    /// Telegram ships with the message. Free — no extra request per item.
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaPage {
    pub items: Vec<MediaItem>,
    /// null = end of history.
    pub next_offset_id: Option<i32>,
    pub total: Option<i64>,
}

/* ------------------------------------------------------------- downloads */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Paused,
    Done,
    Error,
    Cancelled,
}

impl JobState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Error | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub channel_id: i64,
    pub channel_title: String,
    pub message_id: i32,
    pub name: String,
    pub dest_path: String,
    pub size: u64,
    pub done: u64,
    pub state: JobState,
    pub speed_bps: u64,
    pub eta_s: Option<u64>,
    pub workers: u32,
    pub worker_fill: Vec<f32>,
    pub error: Option<String>,
    pub flood_wait_until: Option<i64>,
    pub created_at: i64,
}

/// Emitted on a fixed cadence (see `download::PROGRESS_INTERVAL`) rather than
/// per chunk — §11.9. At eight workers across three files, per-chunk events
/// would be thousands of IPC messages a second for no visible benefit.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEntry {
    pub id: String,
    pub done: u64,
    pub speed_bps: u64,
    pub eta_s: Option<u64>,
    pub workers: u32,
    pub worker_fill: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressBatch {
    pub jobs: Vec<ProgressEntry>,
    pub total_bps: u64,
}

/* -------------------------------------------------------------- settings */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub download_root: String,
    pub max_workers: u32,
    pub max_concurrent_jobs: u32,
    pub adaptive: bool,
    pub organize: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let root = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("TeleWire");
        Self {
            download_root: root.to_string_lossy().into_owned(),
            // Eight parallel range-fetches per file is the ceiling grammers'
            // own concurrent downloader would never exceed by much, and stays
            // well clear of flood-wait territory for a personal account (§11.8).
            max_workers: 8,
            max_concurrent_jobs: 3,
            adaptive: true,
            organize: true,
        }
    }
}

impl Settings {
    /// Clamp anything that arrived from the UI. The sliders are bounded, but a
    /// settings file edited by hand should not be able to point the engine at
    /// 500 concurrent connections.
    pub fn sanitized(mut self) -> Self {
        self.max_workers = self.max_workers.clamp(1, 16);
        self.max_concurrent_jobs = self.max_concurrent_jobs.clamp(1, 8);
        if self.download_root.trim().is_empty() {
            self.download_root = Self::default().download_root;
        }
        self
    }
}

/* ---------------------------------------------------------------- events */

pub const EV_PROGRESS: &str = "telewire://progress";
pub const EV_JOB: &str = "telewire://job";
pub const EV_AUTH: &str = "telewire://auth";
