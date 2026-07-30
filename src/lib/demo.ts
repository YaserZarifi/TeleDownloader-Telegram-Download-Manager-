/**
 * FIXTURES ONLY — this module never talks to Telegram and never ships any
 * behaviour to the real backend.
 *
 * `ipc.ts` dynamically imports this file when `__TAURI_INTERNALS__` is absent
 * (i.e. `npm run dev` in a plain browser) and wires `invoke`/`listen` to the
 * two exports at the bottom. Nothing else in the app should import it: the
 * Rust commands in `src-tauri` are the only real implementation, and this file
 * exists purely so the interface can be exercised and design-reviewed without
 * an account.
 *
 * Two things here are deliberate and worth reading before editing:
 *
 *  1. Media generation is *deterministic*. Every item is a pure function of
 *     (channel id, index), derived from a seeded mulberry32 — never
 *     `Math.random()`. The virtualized list re-requests overlapping ranges as
 *     the user scrolls, so a non-deterministic generator would make rows
 *     flicker and change identity mid-scroll. See `itemAt` / `msgIdAt`.
 *
 *  2. Downloads are driven by one shared `setInterval` at TICK_MS, not by
 *     per-job timers. It is a small discrete simulation: it promotes queued
 *     jobs, integrates bytes from a jittered throughput target, ramps the
 *     adaptive worker count, and emits exactly one ProgressBatch per tick.
 *     See `tick()`.
 */

import type {
  AuthState,
  ChannelInfo,
  Job,
  JobState,
  MediaFilter,
  MediaItem,
  MediaKind,
  MediaPage,
  ProgressBatch,
  Settings,
  TgUser,
} from "./types";

/* ========================================================================== *
 * Deterministic PRNG
 * ========================================================================== */

/**
 * mulberry32 — 32-bit state, fast, good enough for fixtures. Seeded explicitly
 * everywhere so the same (channel, index) always yields the same item, on any
 * machine, on any page of the virtualized list.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a style mixer so we can fold several numbers into one seed. */
function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const lo = Math.abs(p) >>> 0;
    const hi = Math.floor(Math.abs(p) / 0x100000000) >>> 0;
    h = Math.imul(h ^ lo, 0x01000193);
    h = Math.imul(h ^ hi, 0x01000193);
    h = Math.imul(h ^ (p < 0 ? 1 : 0), 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length) % xs.length];
}

function between(rnd: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rnd();
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* ========================================================================== *
 * Argument access (the bridge hands us `Record<string, unknown>`)
 * ========================================================================== */

type Args = Record<string, unknown> | undefined;

function argStr(args: Args, key: string): string {
  const v = args?.[key];
  return typeof v === "string" ? v : "";
}

function argNum(args: Args, key: string, fallback = 0): number {
  const v = args?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function argNumList(args: Args, key: string): number[] {
  const v = args?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

/* ========================================================================== *
 * Event bus — mirrors Tauri's `listen`
 * ========================================================================== */

/** Must match `EV` in ipc.ts exactly. */
const EV = {
  progress: "telewire://progress",
  job: "telewire://job",
  auth: "telewire://auth",
} as const;

type EventPayload = AuthState | Job | ProgressBatch;
type Sink = (e: { payload: unknown }) => void;

const listeners = new Map<string, Set<Sink>>();

function emit(event: string, payload: EventPayload): void {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  // Copy: a handler may unsubscribe while we iterate.
  for (const cb of [...set]) cb({ payload });
}

/* ========================================================================== *
 * Storage helpers (never throw — private mode / disabled storage)
 * ========================================================================== */

const AUTH_KEY = "telewire.demo.auth";
const SETTINGS_KEY = "telewire.demo.settings";

function readStore(store: Storage | null, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStore(store: Storage | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* storage unavailable — the demo just becomes non-persistent */
  }
}

const session = (): Storage | null =>
  typeof sessionStorage === "undefined" ? null : sessionStorage;
const local = (): Storage | null =>
  typeof localStorage === "undefined" ? null : localStorage;

/* ========================================================================== *
 * Auth
 * ========================================================================== */

const DEMO_USER: TgUser = {
  id: 704_118_263,
  first_name: "Ada",
  last_name: "Ferris",
  username: "ada_demo",
  phone: "+1 555 0142",
};

const DEFAULT_API_ID = 611335;

const AUTH_STAGES = [
  "needs_credentials",
  "needs_phone",
  "needs_code",
  "needs_password",
  "ready",
  "error",
] as const;

function loadAuth(): AuthState {
  const raw = readStore(session(), AUTH_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "stage" in parsed &&
        typeof (parsed as { stage: unknown }).stage === "string" &&
        (AUTH_STAGES as readonly string[]).includes((parsed as { stage: string }).stage)
      ) {
        return parsed as AuthState;
      }
    } catch {
      /* fall through to the fresh state */
    }
  }
  return { stage: "needs_credentials" };
}

let auth: AuthState = loadAuth();
let apiId = DEFAULT_API_ID;

/** Single funnel for auth changes: persist, then push the event. */
function setAuth(next: AuthState): AuthState {
  auth = next;
  writeStore(session(), AUTH_KEY, JSON.stringify(next));
  // Deferred so the invoke() promise settles before the pushed event lands,
  // which is the ordering the real backend produces.
  queueMicrotask(() => emit(EV.auth, next));
  return next;
}

/* ========================================================================== *
 * Channels
 * ========================================================================== */

/** Tiny inline avatar so the photo rendering path is exercised. */
function avatar(letters: string, from: string, to: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="64" height="64" rx="32" fill="url(#a)"/>` +
    `<text x="32" y="41" text-anchor="middle" font-family="Segoe UI,Helvetica,sans-serif"` +
    ` font-size="24" font-weight="600" fill="#ffffff">${letters}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const CHANNELS: ChannelInfo[] = [
  // Saved Messages, a bot and a person, so every rail category is reachable
  // in demo mode and not only the two that channels/groups cover.
  {
    id: 770010001,
    title: "Saved Messages",
    username: null,
    participants: null,
    photo: null,
    broadcast: false,
    kind: "saved",
  },
  {
    id: 770010002,
    title: "Media Fetch Bot",
    username: "mediafetchbot",
    participants: null,
    photo: null,
    broadcast: false,
    kind: "bot",
  },
  {
    id: 770010003,
    title: "Priya Raghavan",
    username: "praghavan",
    participants: null,
    photo: avatar("PR", "#d4633b", "#8c2f6f"),
    broadcast: false,
    kind: "person",
  },
  {
    id: -1001204775319,
    title: "Archive — Documentary Vault",
    username: "docvault",
    participants: 148_920,
    photo: avatar("DV", "#3b6fd4", "#7d4fd6"),
    broadcast: true,
    kind: "channel",
  },
  {
    id: -1001338910477,
    title: "Rust Weekly Talks",
    username: "rustweekly",
    participants: 41_337,
    photo: null,
    broadcast: true,
    kind: "channel",
  },
  {
    id: -1001472066218,
    title: "Field Recordings & Ambient",
    username: null,
    participants: 6_412,
    photo: avatar("FR", "#1f9d7a", "#0f6f8c"),
    broadcast: true,
    kind: "channel",
  },
  {
    id: -1001559430062,
    title: "Sunday Photo Walk",
    username: "sundayphotowalk",
    participants: 22_188,
    photo: null,
    broadcast: false,
    kind: "group",
  },
  {
    id: -1001610338925,
    title: "Homelab Ops (staff)",
    username: null,
    participants: 87,
    photo: null,
    broadcast: false,
    kind: "group",
  },
  {
    id: -1001744029183,
    title: "Ephemeris — Space Imagery",
    username: "ephemeris_img",
    participants: 903_551,
    photo: null,
    broadcast: true,
    kind: "channel",
  },
  {
    id: -1001827365440,
    title: "Uni Lectures: Distributed Systems",
    username: "ds_lectures",
    participants: null,
    photo: null,
    broadcast: true,
    kind: "channel",
  },
  {
    id: -1001998120744,
    title: "Scan Group (private)",
    username: null,
    participants: 1_204,
    photo: null,
    broadcast: false,
    kind: "group",
  },
];

/** Channels invented by `resolve_channel`, so later lookups still find them. */
const resolved = new Map<number, ChannelInfo>();

function channelById(id: number): ChannelInfo | null {
  return CHANNELS.find((c) => c.id === id) ?? resolved.get(id) ?? null;
}

function resolveChannel(query: string): ChannelInfo {
  const q = query.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (q.length === 0) throw "Enter a @username, t.me link or channel name.";

  const hit = CHANNELS.find(
    (c) =>
      c.username?.toLowerCase() === q.toLowerCase() ||
      c.title.toLowerCase().includes(q.toLowerCase())
  );
  if (hit) return hit;

  const seed = mix(...Array.from(q).map((ch) => ch.charCodeAt(0)));
  const rnd = mulberry32(seed);
  const info: ChannelInfo = {
    // Telegram-shaped id, stable for a given query.
    id: -(1_001_000_000_000 + Math.floor(rnd() * 999_000_000)),
    title: q.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    username: /^[a-z0-9_]{4,32}$/i.test(q) ? q : null,
    participants: rnd() < 0.15 ? null : Math.floor(between(rnd, 120, 780_000)),
    photo: null,
    broadcast: rnd() < 0.7,
    kind: rnd() < 0.7 ? "channel" : "group",
  };
  resolved.set(info.id, info);
  return info;
}

/* ========================================================================== *
 * Media generation
 * ========================================================================== */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** Every channel serves exactly this many items, to stress the virtual list. */
const MEDIA_TOTAL = 5000;

/** Newest message id; ids step down by 3–5 so history has plausible gaps. */
const MSG_ID_TOP = 486_300;

/** ~3 years of history spread evenly (plus jitter) across the 5000 items. */
const HISTORY_SECONDS = 3 * 365 * 24 * 3600;
const DATE_STEP = Math.floor(HISTORY_SECONDS / MEDIA_TOTAL);

/**
 * Anchored to today's UTC noon rather than `Date.now()` so relative-date
 * formatting stays sensible while remaining constant for the whole session —
 * a moving anchor would shift every row's date between pages.
 */
const DATE_ANCHOR = Math.floor(Date.now() / 86_400_000) * 86_400 + 43_200;

const channelSeed = (channelId: number): number => mix(channelId, 0x5ee0);

/**
 * Message ids are strictly decreasing in `index` (index 0 = newest), which is
 * what lets `startIndex` binary-search an `offset_id` instead of scanning.
 * Gap is 3 + [0,2], so consecutive ids can never collide or invert.
 */
function msgIdAt(channelId: number, index: number): number {
  const jitter = Math.floor(mulberry32(mix(channelSeed(channelId), index, 7))() * 3);
  return MSG_ID_TOP - index * 3 - jitter;
}

/** Same monotonic trick as ids: jitter is capped below the step. */
function dateAt(channelId: number, index: number): number {
  const jitter = Math.floor(
    mulberry32(mix(channelSeed(channelId), index, 11))() * DATE_STEP * 0.9
  );
  return DATE_ANCHOR - index * DATE_STEP - jitter;
}

/** Cheap enough to run over all 5000 items when counting a filter. */
function kindAt(channelId: number, index: number): MediaKind {
  const r = mulberry32(mix(channelSeed(channelId), index, 3))();
  if (r < 0.4) return "video";
  if (r < 0.62) return "photo";
  if (r < 0.82) return "document";
  return "audio";
}

const EXT: Record<MediaKind, readonly string[]> = {
  video: ["mkv", "mp4", "mov", "webm", "avi"],
  audio: ["mp3", "flac", "m4a", "ogg", "wav"],
  photo: ["jpg", "png", "webp", "heic"],
  document: ["pdf", "zip", "epub", "iso", "7z", "docx", "csv", "tar.gz"],
};

const MIME: Record<string, string> = {
  mkv: "video/x-matroska",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  zip: "application/zip",
  epub: "application/epub+zip",
  iso: "application/x-iso9660-image",
  "7z": "application/x-7z-compressed",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  "tar.gz": "application/gzip",
};

const SIZE_RANGE: Record<MediaKind, readonly [number, number]> = {
  photo: [420 * KB, 14 * MB],
  audio: [2 * MB, 190 * MB],
  document: [400 * KB, 640 * MB],
  video: [42 * MB, 4 * GB],
};

const SHOWS = [
  "The Long Winter",
  "Halyard",
  "Cold Open",
  "Meridian Line",
  "Salt & Iron",
  "Nightjar",
  "The Cartographers",
] as const;
const FILMS = [
  "Harbour Lights",
  "Second Sun",
  "The Quiet Machine",
  "Umbra",
  "Radio Silence",
  "Ninety Degrees North",
] as const;
const GROUPS = ["AMIABLE", "NTb", "FLUX", "RARBG", "CtrlHD", "KOGi"] as const;
const RES = ["720p", "1080p", "1440p", "2160p"] as const;
const SOURCE = ["WEB-DL", "BluRay", "HDTV", "WEBRip", "REMUX"] as const;
const CODEC = ["x264", "x265", "H.264", "HEVC", "AV1"] as const;
const ARTISTS = [
  "Kiasmos",
  "Rival Consoles",
  "Hania Rani",
  "Oliver Coates",
  "Emeralds",
  "Loscil",
] as const;
const TRACKS = [
  "Blurred EP",
  "Persistent Repeat",
  "Glass Harbour",
  "Low Tide",
  "Night Ferry",
  "Ostinato",
] as const;
const TOPICS = [
  "Consensus and Raft",
  "Vector Clocks",
  "Backpressure",
  "CRDTs in Practice",
  "Failure Detectors",
  "Sharding Strategies",
] as const;
const DOCS = [
  "Designing Data-Intensive Applications",
  "Field Notes 2023",
  "Annual Report",
  "Firmware Release Notes",
  "Site Survey",
  "Archive Manifest",
] as const;
const SLUGS = [
  "arch-linux",
  "debian-13.2-netinst",
  "sensor-dump",
  "raw-scans",
  "backup-2024",
  "telemetry",
] as const;

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

interface Stamp {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

/** UTC only — filenames must not vary with the reviewer's timezone. */
function stampOf(unix: number): Stamp {
  const dt = new Date(unix * 1000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
    ss: dt.getUTCSeconds(),
  };
}

function nameFor(rnd: () => number, kind: MediaKind, ext: string, s: Stamp, index: number): string {
  switch (kind) {
    case "video": {
      const style = rnd();
      if (style < 0.4) {
        const se = `S${pad(1 + Math.floor(rnd() * 6))}E${pad(1 + (index % 22))}`;
        return `${pick(rnd, SHOWS).replace(/ /g, ".")}.${se}.${pick(rnd, RES)}.${pick(
          rnd,
          SOURCE
        )}.${pick(rnd, CODEC)}-${pick(rnd, GROUPS)}.${ext}`;
      }
      if (style < 0.78) {
        const year = 1998 + Math.floor(rnd() * 27);
        return `${pick(rnd, FILMS).replace(/ /g, ".")}.${year}.${pick(rnd, RES)}.${pick(
          rnd,
          SOURCE
        )}.${pick(rnd, CODEC)}.${ext}`;
      }
      return `VID_${s.y}${pad(s.m)}${pad(s.d)}_${pad(s.hh)}${pad(s.mm)}${pad(s.ss)}.${ext}`;
    }
    case "audio": {
      const style = rnd();
      if (style < 0.45) return `${pick(rnd, ARTISTS)} - ${pick(rnd, TRACKS)}.${ext}`;
      if (style < 0.8)
        return `${pad(1 + (index % 18))}. ${pick(rnd, TRACKS)} (remaster).${ext}`;
      return `ep${pad(120 + (index % 240), 3)} - ${pick(rnd, TOPICS)}.${ext}`;
    }
    case "photo": {
      const style = rnd();
      if (style < 0.55)
        return `IMG_${s.y}${pad(s.m)}${pad(s.d)}_${pad(s.hh)}${pad(s.mm)}${pad(s.ss)}.${ext}`;
      if (style < 0.8) return `DSC${pad(1000 + (index % 8000), 5)}.${ext}`;
      return `${pick(rnd, SLUGS)}-${pad(index % 400, 3)}.${ext}`;
    }
    case "document": {
      if (ext === "iso" || ext === "zip" || ext === "7z" || ext === "tar.gz")
        return `${pick(rnd, SLUGS)}-${s.y}${pad(s.m)}${pad(s.d)}.${ext}`;
      if (ext === "csv") return `${pick(rnd, SLUGS)}_${s.y}-${pad(s.m)}.${ext}`;
      return `${pick(rnd, DOCS)} (${s.y}).${ext}`;
    }
  }
}

/**
 * The whole media fixture in one pure function. Called for every visible row,
 * so it must stay allocation-light and side-effect free.
 */
function itemAt(channelId: number, index: number): MediaItem {
  const rnd = mulberry32(mix(channelSeed(channelId), index, 23));
  const kind = kindAt(channelId, index);
  const ext = pick(rnd, EXT[kind]);
  const date = dateAt(channelId, index);
  const stamp = stampOf(date);
  const [lo, hi] = SIZE_RANGE[kind];
  // ^2.4 skews toward the small end so 4 GB files are the exception.
  const size = Math.round(lo + (hi - lo) * Math.pow(rnd(), 2.4));

  let duration: number | null = null;
  if (kind === "video") duration = Math.round(between(rnd, 90, 9600));
  else if (kind === "audio") duration = Math.round(between(rnd, 110, 7200));

  return {
    message_id: msgIdAt(channelId, index),
    // Newest message has the highest seq; oldest is 1.
    seq: MEDIA_TOTAL - index,
    name: nameFor(rnd, kind, ext, stamp, index),
    mime: MIME[ext] ?? "application/octet-stream",
    kind,
    size,
    date,
    duration,
  };
}

/** First index whose message id is strictly below `offsetId` (ids descend). */
function startIndex(channelId: number, offsetId: number): number {
  if (offsetId <= 0) return 0;
  let lo = 0;
  let hi = MEDIA_TOTAL;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msgIdAt(channelId, mid) < offsetId) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const filterCounts = new Map<string, number>();

function countFor(channelId: number, filter: MediaFilter): number {
  if (filter === "all") return MEDIA_TOTAL;
  const key = `${channelId}:${filter}`;
  const cached = filterCounts.get(key);
  if (cached !== undefined) return cached;
  let n = 0;
  for (let i = 0; i < MEDIA_TOTAL; i++) if (kindAt(channelId, i) === filter) n++;
  filterCounts.set(key, n);
  return n;
}

async function listMedia(
  channelId: number,
  offsetId: number,
  limit: number,
  filter: MediaFilter
): Promise<MediaPage> {
  await sleep(180); // simulated round trip, matches a warm Telegram session
  const take = Math.max(1, Math.min(500, limit || 60));
  const items: MediaItem[] = [];
  let i = startIndex(channelId, offsetId);

  while (i < MEDIA_TOTAL && items.length < take) {
    if (filter === "all" || kindAt(channelId, i) === filter) items.push(itemAt(channelId, i));
    i++;
  }

  // Look ahead for one more match; if there is none we are genuinely at the
  // end of history and must report null so the list stops paging.
  let more = false;
  for (let j = i; j < MEDIA_TOTAL; j++) {
    if (filter === "all" || kindAt(channelId, j) === filter) {
      more = true;
      break;
    }
  }

  const last = items.length > 0 ? items[items.length - 1] : null;
  return {
    items,
    next_offset_id: more && last ? last.message_id : null,
    total: countFor(channelId, filter),
  };
}

/* ========================================================================== *
 * Settings
 * ========================================================================== */

const DEFAULT_SETTINGS: Settings = {
  download_root: "C:\\Users\\demo\\Downloads\\TeleWire",
  max_workers: 8,
  max_concurrent_jobs: 3,
  adaptive: true,
  organize: true,
};

function loadSettings(): Settings {
  const raw = readStore(local(), SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== "object" || p === null) return { ...DEFAULT_SETTINGS };
    const o = p as Partial<Record<keyof Settings, unknown>>;
    return {
      download_root:
        typeof o.download_root === "string" && o.download_root.length > 0
          ? o.download_root
          : DEFAULT_SETTINGS.download_root,
      max_workers: typeof o.max_workers === "number" ? o.max_workers : DEFAULT_SETTINGS.max_workers,
      max_concurrent_jobs:
        typeof o.max_concurrent_jobs === "number"
          ? o.max_concurrent_jobs
          : DEFAULT_SETTINGS.max_concurrent_jobs,
      adaptive: typeof o.adaptive === "boolean" ? o.adaptive : DEFAULT_SETTINGS.adaptive,
      organize: typeof o.organize === "boolean" ? o.organize : DEFAULT_SETTINGS.organize,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings: Settings = loadSettings();

const maxWorkers = (): number => Math.max(1, Math.min(16, Math.round(settings.max_workers)));
const maxConcurrent = (): number =>
  Math.max(1, Math.min(8, Math.round(settings.max_concurrent_jobs)));

/* ========================================================================== *
 * Download simulation
 * ========================================================================== */

const TICK_MS = 400;
/** Seconds of wall clock the worker count takes to climb one step (2 -> 8). */
const WORKER_STEP_MS = 1100;

const FAILURES = [
  "FLOOD_WAIT_A (420) — Telegram is rate limiting this session.",
  "Disk write failed: no space left on device (os error 112).",
  "FILE_REFERENCE_EXPIRED — re-resolve the message and retry.",
  "Connection reset by peer while fetching chunk 41.",
] as const;

interface Sim {
  job: Job;
  /** Per-job PRNG stream: jitter must not use Math.random(). */
  rnd: () => number;
  /** Steady-state throughput this file would reach, bytes/sec. */
  targetBps: number;
  /** EMA of the jittered instantaneous rate — keeps the number readable. */
  smoothBps: number;
  /** Milliseconds actually spent in `running` (excludes paused time). */
  runningMs: number;
  /** Fraction of the file at which this job should fail, or null. */
  failAt: number | null;
  failMsg: string;
  /** Independent phase/rate per worker so the fill bars never move in lockstep. */
  phase: number[];
  rate: number[];
}

const sims = new Map<string, Sim>();
/** Preserves enqueue order for list_jobs and for promoting queued jobs. */
const order: string[] = [];
let jobCounter = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sep(root: string): string {
  return root.includes("\\") ? "\\" : "/";
}

function safeSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "-").trim();
}

function destPath(channelTitle: string, item: MediaItem): string {
  const s = sep(settings.download_root);
  const st = stampOf(item.date);
  const parts = [settings.download_root.replace(/[\\/]+$/, "")];
  if (settings.organize) parts.push(safeSegment(channelTitle), `${st.y}-${pad(st.m)}`);
  parts.push(safeSegment(item.name));
  return parts.join(s);
}

/** Locate a generated item by its message id (ids descend, so binary search). */
function itemByMessageId(channelId: number, messageId: number): MediaItem | null {
  const idx = startIndex(channelId, messageId + 1);
  if (idx < MEDIA_TOTAL && msgIdAt(channelId, idx) === messageId) return itemAt(channelId, idx);
  return null;
}

function transition(sim: Sim, state: JobState): void {
  if (sim.job.state === state) return;
  sim.job.state = state;
  if (state !== "running") {
    sim.job.speed_bps = 0;
    sim.job.worker_fill = [];
    sim.job.workers = 0;
  }
  emit(EV.job, { ...sim.job });
}

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(tick, TICK_MS);
}

function stopTimerIfIdle(): void {
  if (timer === null) return;
  const busy = [...sims.values()].some(
    (s) => s.job.state === "running" || s.job.state === "queued"
  );
  if (!busy) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * The simulation loop. One tick = TICK_MS of simulated transfer for every
 * running job. Order matters:
 *   1. promote queued jobs into free concurrency slots,
 *   2. integrate bytes for each running job (jittered rate x elapsed time),
 *   3. apply the adaptive worker ramp and per-worker fill,
 *   4. resolve terminal outcomes (failure / completion),
 *   5. emit exactly one ProgressBatch for the whole tick.
 * Paused jobs are skipped entirely, so they neither advance nor report speed.
 */
function tick(): void {
  // 1. promotion
  let running = [...sims.values()].filter((s) => s.job.state === "running").length;
  if (running < maxConcurrent()) {
    for (const id of order) {
      if (running >= maxConcurrent()) break;
      const s = sims.get(id);
      if (s && s.job.state === "queued") {
        transition(s, "running");
        running++;
      }
    }
  }

  const live: ProgressBatch["jobs"] = [];
  let totalBps = 0;

  for (const id of order) {
    const sim = sims.get(id);
    if (!sim) continue;
    const job = sim.job;

    if (job.state === "paused") {
      live.push({
        id: job.id,
        done: job.done,
        speed_bps: 0,
        eta_s: null,
        workers: 0,
        worker_fill: [],
      });
      continue;
    }
    if (job.state !== "running") continue;

    sim.runningMs += TICK_MS;

    // 3a. adaptive controller: ramp 2 -> max_workers over the first seconds.
    const target = sim.runningMs / WORKER_STEP_MS;
    job.workers = settings.adaptive
      ? Math.max(2, Math.min(maxWorkers(), 2 + Math.floor(target)))
      : maxWorkers();

    // 2. throughput: jitter around the target, scaled by how far the worker
    // ramp has come, then smoothed so the displayed number is not noise.
    const rampFactor = 0.35 + 0.65 * (job.workers / maxWorkers());
    const instant = sim.targetBps * rampFactor * between(sim.rnd, 0.72, 1.28);
    sim.smoothBps = sim.smoothBps === 0 ? instant : sim.smoothBps * 0.6 + instant * 0.4;

    job.done = Math.min(job.size, job.done + (sim.smoothBps * TICK_MS) / 1000);

    // 3b. per-worker fill: each worker sweeps its own chunk at its own rate.
    const secs = sim.runningMs / 1000;
    const fill: number[] = [];
    for (let w = 0; w < job.workers; w++) {
      const v = (secs * sim.rate[w] + sim.phase[w]) % 1;
      fill.push(Math.round(v * 1000) / 1000);
    }
    job.worker_fill = fill;

    // 4. terminal outcomes
    if (sim.failAt !== null && job.done / job.size >= sim.failAt) {
      job.error = sim.failMsg;
      job.flood_wait_until = sim.failMsg.startsWith("FLOOD_WAIT") ? nowSec() + 420 : null;
      job.eta_s = null;
      transition(sim, "error");
      continue;
    }

    if (job.done >= job.size) {
      job.done = job.size;
      job.eta_s = 0;
      transition(sim, "done");
      continue;
    }

    job.speed_bps = Math.round(sim.smoothBps);
    job.eta_s = sim.smoothBps > 0 ? Math.ceil((job.size - job.done) / sim.smoothBps) : null;
    totalBps += job.speed_bps;

    live.push({
      id: job.id,
      done: Math.round(job.done),
      speed_bps: job.speed_bps,
      eta_s: job.eta_s,
      workers: job.workers,
      worker_fill: job.worker_fill,
    });
  }

  // 5. one batch per tick, even when empty, so the wire can fall back to zero.
  emit(EV.progress, { jobs: live, total_bps: totalBps });
  stopTimerIfIdle();
}

function enqueue(channelId: number, messageIds: number[]): Job[] {
  const channel = channelById(channelId);
  const title = channel?.title ?? "Unknown channel";
  const created: Job[] = [];

  for (const messageId of messageIds) {
    const item = itemByMessageId(channelId, messageId) ?? {
      message_id: messageId,
      seq: 0,
      name: `message_${messageId}.bin`,
      mime: "application/octet-stream",
      kind: "document" as MediaKind,
      size: 12 * MB,
      date: nowSec(),
      duration: null,
    };

    jobCounter += 1;
    const id = `dj-${jobCounter.toString(36)}-${messageId.toString(36)}`;
    const rnd = mulberry32(mix(channelId, messageId, jobCounter, 0xd0));

    const job: Job = {
      id,
      channel_id: channelId,
      channel_title: title,
      message_id: messageId,
      name: item.name,
      dest_path: destPath(title, item),
      size: item.size,
      done: 0,
      state: "queued",
      speed_bps: 0,
      eta_s: null,
      workers: 0,
      worker_fill: [],
      error: null,
      flood_wait_until: null,
      created_at: nowSec(),
    };

    const failing = rnd() < 1 / 12; // ~1 in 12 jobs fails so the error UI is reachable
    const sim: Sim = {
      job,
      rnd,
      targetBps: between(rnd, 2 * MB, 30 * MB),
      smoothBps: 0,
      runningMs: 0,
      failAt: failing ? between(rnd, 0.12, 0.86) : null,
      failMsg: pick(rnd, FAILURES),
      phase: Array.from({ length: 16 }, () => rnd()),
      rate: Array.from({ length: 16 }, () => between(rnd, 0.18, 1.15)),
    };

    sims.set(id, sim);
    order.push(id);
    created.push({ ...job });
    emit(EV.job, { ...job });
  }

  if (created.length > 0) ensureTimer();
  return created;
}

function requireSim(jobId: string): Sim {
  const sim = sims.get(jobId);
  if (!sim) throw `No such job: ${jobId}`;
  return sim;
}

function pauseJob(jobId: string): void {
  const sim = requireSim(jobId);
  if (sim.job.state !== "running" && sim.job.state !== "queued")
    throw `Only running or queued downloads can be paused (this one is ${sim.job.state}).`;
  sim.smoothBps = 0;
  transition(sim, "paused");
  stopTimerIfIdle();
}

function resumeJob(jobId: string): void {
  const sim = requireSim(jobId);
  if (sim.job.state !== "paused") throw "That download is not paused.";
  // Back to the queue so the concurrency limit is re-applied fairly.
  transition(sim, "queued");
  ensureTimer();
}

function cancelJob(jobId: string): void {
  const sim = requireSim(jobId);
  if (sim.job.state === "done" || sim.job.state === "cancelled") return;
  sim.job.eta_s = null;
  transition(sim, "cancelled");
  stopTimerIfIdle();
}

function retryJob(jobId: string): void {
  const sim = requireSim(jobId);
  if (sim.job.state !== "error" && sim.job.state !== "cancelled")
    throw "Only failed or cancelled downloads can be retried.";
  sim.job.error = null;
  sim.job.flood_wait_until = null;
  sim.failAt = null; // a retry in the demo always succeeds
  sim.smoothBps = 0;
  // `done` is kept: the real backend resumes from the .part file.
  transition(sim, "queued");
  ensureTimer();
}

function clearFinished(): void {
  for (let i = order.length - 1; i >= 0; i--) {
    const sim = sims.get(order[i]);
    if (!sim) {
      order.splice(i, 1);
      continue;
    }
    const s = sim.job.state;
    if (s === "done" || s === "cancelled" || s === "error") {
      sims.delete(sim.job.id);
      order.splice(i, 1);
    }
  }
}

function listJobs(): Job[] {
  return order
    .map((id) => sims.get(id))
    .filter((s): s is Sim => s !== undefined)
    .map((s) => ({ ...s.job, done: Math.round(s.job.done) }));
}

/* ========================================================================== *
 * Command dispatch
 * ========================================================================== */

export async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    /* ---- auth ---------------------------------------------------------- */
    case "get_auth_state":
      return auth;

    case "save_credentials": {
      const id = argNum(args, "apiId", DEFAULT_API_ID);
      const hash = argStr(args, "apiHash").trim();
      if (id <= 0) throw "api_id must be a positive number from my.telegram.org.";
      if (hash.length === 0) throw "api_hash cannot be empty.";
      await sleep(150);
      apiId = id;
      return setAuth({ stage: "needs_phone", api_id: id });
    }

    case "login_start": {
      const phone = argStr(args, "phone").trim();
      if (phone.replace(/\D/g, "").length < 6)
        throw "Enter a phone number in international format, e.g. +1 555 0142.";
      await sleep(260);
      return setAuth({ stage: "needs_code", phone, code_length: 5 });
    }

    case "login_submit_code": {
      const code = argStr(args, "code").trim();
      if (!/^\d{5}$/.test(code)) throw "PHONE_CODE_INVALID — the code is 5 digits.";
      await sleep(240);
      // 22222 is the demo's two-factor account; anything else signs straight in.
      if (code === "22222")
        return setAuth({ stage: "needs_password", hint: "first pet + year" });
      return setAuth({ stage: "ready", user: DEMO_USER });
    }

    case "login_submit_password": {
      const password = argStr(args, "password");
      if (password.length === 0) throw "PASSWORD_EMPTY — enter your two-factor password.";
      await sleep(300);
      return setAuth({ stage: "ready", user: DEMO_USER });
    }

    case "logout": {
      await sleep(160);
      return setAuth({ stage: "needs_phone", api_id: apiId });
    }

    /* ---- channels ------------------------------------------------------ */
    case "list_dialogs":
      await sleep(220);
      return CHANNELS.map((c) => ({ ...c }));

    case "resolve_channel":
      await sleep(200);
      return { ...resolveChannel(argStr(args, "query")) };

    case "list_media": {
      const filter = argStr(args, "filter");
      const known: readonly string[] = ["all", "video", "audio", "photo", "document"];
      return listMedia(
        argNum(args, "channelId"),
        argNum(args, "offsetId"),
        argNum(args, "limit", 60),
        (known.includes(filter) ? filter : "all") as MediaFilter
      );
    }

    /* ---- downloads ----------------------------------------------------- */
    case "enqueue_download": {
      await sleep(120);
      return enqueue(argNum(args, "channelId"), argNumList(args, "messageIds"));
    }

    case "pause_download":
      pauseJob(argStr(args, "jobId"));
      return null;

    case "resume_download":
      resumeJob(argStr(args, "jobId"));
      return null;

    case "cancel_download":
      cancelJob(argStr(args, "jobId"));
      return null;

    case "retry_download":
      retryJob(argStr(args, "jobId"));
      return null;

    case "list_jobs":
      return listJobs();

    case "clear_finished":
      clearFinished();
      return null;

    /* ---- system -------------------------------------------------------- */
    case "get_settings":
      return { ...settings };

    case "set_settings": {
      const incoming = args?.["settings"];
      if (typeof incoming !== "object" || incoming === null) throw "Invalid settings payload.";
      const o = incoming as Partial<Record<keyof Settings, unknown>>;
      const next: Settings = {
        download_root:
          typeof o.download_root === "string" && o.download_root.trim().length > 0
            ? o.download_root
            : settings.download_root,
        max_workers:
          typeof o.max_workers === "number"
            ? Math.max(1, Math.min(16, Math.round(o.max_workers)))
            : settings.max_workers,
        max_concurrent_jobs:
          typeof o.max_concurrent_jobs === "number"
            ? Math.max(1, Math.min(8, Math.round(o.max_concurrent_jobs)))
            : settings.max_concurrent_jobs,
        adaptive: typeof o.adaptive === "boolean" ? o.adaptive : settings.adaptive,
        organize: typeof o.organize === "boolean" ? o.organize : settings.organize,
      };
      settings = next;
      writeStore(local(), SETTINGS_KEY, JSON.stringify(next));
      await sleep(90);
      return { ...next };
    }

    case "pick_directory":
      await sleep(400); // a native dialog is never instant
      return "D:\\Media\\TeleWire";

    case "reveal_in_folder":
    case "open_url":
      // No-ops: the browser cannot open a file manager, and popping a tab
      // during a design review would be hostile.
      return null;

    default:
      // ipc.ts turns a thrown string into a displayable IpcError.
      throw `"${cmd}" is not available in demo mode — run the desktop app for the real backend.`;
  }
}

export async function listen(
  event: string,
  cb: (e: { payload: unknown }) => void
): Promise<() => void> {
  let set = listeners.get(event);
  if (!set) {
    set = new Set<Sink>();
    listeners.set(event, set);
  }
  const sinks = set;
  sinks.add(cb);
  return () => {
    sinks.delete(cb);
  };
}
