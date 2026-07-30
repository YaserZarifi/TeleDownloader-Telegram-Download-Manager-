/**
 * The Rust <-> UI contract. Every type here has an exact serde counterpart in
 * `src-tauri/src/model.rs`. If you change one side, change the other.
 *
 * Wire-format rules that Rust obeys and TypeScript can rely on:
 *  - enums are `#[serde(tag = "stage" | "kind" | "state", rename_all = "snake_case")]`
 *  - i64 ids cross the bridge as JS `number`; Telegram ids are well inside
 *    2^53 so this is safe (chat ids peak around 10^13).
 *  - all byte counts are u64 and also safe as `number` (< 8 PB).
 */

/* ---------- auth -------------------------------------------------------- */

export interface TgUser {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  phone: string | null;
}

export type AuthState =
  /** No api_id/api_hash on this machine yet. */
  | { stage: "needs_credentials" }
  /** Credentials known, no valid session. */
  | { stage: "needs_phone"; api_id: number }
  /** A login code has been sent. */
  | { stage: "needs_code"; phone: string; code_length: number | null }
  /** Two-factor password required. */
  | { stage: "needs_password"; hint: string | null }
  /** Signed in and connected. */
  | { stage: "ready"; user: TgUser }
  /** Something went wrong mid-flow; `message` is safe to show. */
  | { stage: "error"; message: string; recoverable: boolean };

/* ---------- channels & media -------------------------------------------- */

/** Telegram's own classification, used to group the chat rail. */
export type ChatKind = "saved" | "channel" | "group" | "bot" | "person";

export interface ChannelInfo {
  id: number;
  title: string;
  username: string | null;
  /** null when the channel exposes no member count. */
  participants: number | null;
  /** Small base64 data URI, or null. */
  photo: string | null;
  /** True for broadcast channels, false for groups and Saved Messages. */
  broadcast: boolean;
  kind: ChatKind;
}

export type MediaKind = "video" | "audio" | "photo" | "document";

export interface MediaItem {
  message_id: number;
  /** Chronological position in the channel, oldest = 1. Real data, not a UI counter. */
  seq: number;
  name: string;
  mime: string;
  kind: MediaKind;
  size: number;
  /** Unix seconds. */
  date: number;
  /** Video/audio duration in seconds, when known. */
  duration: number | null;
  /** Tiny inline JPEG data URI, or null. Arrives with the listing — free. */
  thumb: string | null;
}

export interface MediaPage {
  items: MediaItem[];
  /** Pass back as `offset_id` to fetch the next page; null = end of history. */
  next_offset_id: number | null;
  /** Total media count in the channel, when Telegram reports it. */
  total: number | null;
}

export type MediaFilter = "all" | "video" | "audio" | "photo" | "document";

/* ---------- downloads ---------------------------------------------------- */

export type JobState =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export interface Job {
  id: string;
  channel_id: number;
  channel_title: string;
  message_id: number;
  name: string;
  /** Final destination (the `.part` file sits alongside it until verified). */
  dest_path: string;
  size: number;
  done: number;
  state: JobState;
  /** Bytes/sec over the last sampling window. */
  speed_bps: number;
  /** Seconds remaining, or null when not computable. */
  eta_s: number | null;
  /** Live worker count — the adaptive controller moves this at runtime. */
  workers: number;
  /** Per-worker fill fraction 0..1, one entry per active worker. */
  worker_fill: number[];
  error: string | null;
  /** Set while Telegram has us in a flood-wait back-off. */
  flood_wait_until: number | null;
  created_at: number;
}

/** Batched every ~400ms while anything is running. Only live jobs appear. */
export interface ProgressBatch {
  jobs: Array<
    Pick<Job, "id" | "done" | "speed_bps" | "eta_s" | "workers" | "worker_fill">
  >;
  /** Sum across all running jobs — drives the wire. */
  total_bps: number;
}

/* ---------- settings ----------------------------------------------------- */

export interface Settings {
  /** Root folder; files land in <root>/<channel>/<YYYY-MM>/<name>. */
  download_root: string;
  /** Upper bound the adaptive controller may not exceed. */
  max_workers: number;
  /** How many files transfer at once. */
  max_concurrent_jobs: number;
  /** Let the controller tune worker count from measured throughput. */
  adaptive: boolean;
  /** Group downloads into <channel>/<YYYY-MM>/ subfolders. */
  organize: boolean;
}
