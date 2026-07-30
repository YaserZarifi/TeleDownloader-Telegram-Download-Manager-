# TeleWire — Telegram Direct-Link Download Manager

> Working name only — rename freely. Suggested repo name: `telewire`.
>
> **Note for Claude Code:** this file is written to also serve as your project
> `CLAUDE.md` — drop it in the repo root and it will be read automatically at
> the start of every session in this project.

## 1. One-line summary

A free, open-source **desktop app** that logs into a user's own Telegram
account, lets them browse a channel's media, and downloads files straight
from Telegram's servers to disk using multiple parallel connections — no
backend, no bot, no cloud relay, no cost, ever.

## 2. Why this exists / core principle

Telegram's own apps already download media efficiently, but there's no
purpose-built, open-source **download-manager-grade** client: pause/resume,
multi-connection segmented downloads, queueing, speed graphs — the IDM
experience, native to Telegram.

**The one rule that shapes every decision below:** everything runs on the
user's own machine. No server, no serverless function, no bot relay. The
only two parties ever exchanging file bytes are Telegram's data centers and
the user's disk.

## 3. Goals (v1)

- [ ] Log into a personal Telegram account (phone + code + optional 2FA)
- [ ] Browse a channel's full media history (documents, videos, photos, audio)
- [ ] Download any file with **parallel multi-connection chunking**
      (matches or beats a generic IDM-style download manager)
- [ ] Pause / resume / cancel downloads
- [ ] Persist login so the user isn't re-authenticating every launch
- [ ] Ship as a native installer for Windows, macOS, and Linux (Tauri)
- [ ] Zero recurring cost, zero server, fully open source (MIT)
- [ ] A distinctive, modern, stylish UI — not a generic template (see §17)
- [ ] Feels genuinely fast: instant window response, smooth scrolling and
      progress updates even on channels with thousands of files (see §17)
- [ ] **Adaptive concurrency** — worker count scales with measured
      real-time throughput, not a fixed guess (see §11)
- [ ] **Downloads survive app restarts and crashes** — nothing is ever
      lost or silently corrupted mid-transfer (see §11)
- [ ] Downloads auto-organize into `<channel>/<year-month>/` folders
      (see §11)
- [ ] **Zero telemetry** — stated explicitly in the README, not just true
      by omission (see §12)

## 4. Non-goals (v1 — explicitly parked)

| Parked idea | Why it's parked | Revisit when |
|---|---|---|
| Public "movie poster" catalog site for anonymous visitors | Needs *some* server-side credential to read a channel on a visitor's behalf — conflicts with "no server" | After v1 ships, as a genuinely separate project |
| Browser/PWA version with Firefox+Safari memory-buffer fallback | Desktop app is the priority per current scope | Phase 2, once desktop v1 is stable |
| Android app | PWA wrapper is the easiest path once Phase 2 exists | After Phase 2 |
| IDM / external download-manager integration via HTTP links | Conflicts with "no server does the relay" — this app *is* the download manager now | Not planned unless requirements change |

## 5. How it works

```
┌─────────────────────────────┐        MTProto (encrypted,          ┌──────────────────┐
│   TeleWire desktop app       │◄──────  parallel connections) ─────►│  Telegram Data     │
│   (Tauri: Rust backend        │                                     │  Center(s)         │
│    + native webview UI)       │                                     └──────────────────┘
│                                │
│   Rust core:                  │
│   - grammers (MTProto client)│
│   - chunked parallel download │
│   - writes straight to disk   │
└─────────────────────────────┘
```

No bot. No Cloudflare Worker. No API server. The Rust backend *is* a
Telegram client, the same way Telegram Desktop is — just purpose-built for
bulk/managed downloading instead of chat.

## 6. Key technical decisions (why we're not doing this differently)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Rust + Tauri**, not Electron | Native performance for real concurrent I/O; small binary; no bundled Chromium |
| 2 | **`grammers`** (Rust MTProto client) over porting the earlier JS prototype | Runs natively in the Tauri backend — no browser API limits (File System Access was Chromium-only; this is now moot since Rust has full native file I/O everywhere) |
| 3 | MTProto (personal account), not the Bot API | Bot API caps file downloads at 20MB and can't read a channel's full historical media. MTProto has no such wall (2GB regular / 4GB Premium) |
| 4 | No server component of any kind | Every earlier design (Cloudflare Worker relay, local HTTP bridge for IDM) added a middleman. Since the desktop app *is* the client, none of that is needed — it downloads exactly like the official Telegram app does, just with a better UI for it |
| 5 | User supplies their own `api_id`/`api_hash` from my.telegram.org | Standard, safe practice for MTProto apps; never bake shared credentials into a public repo |

**Honest caveat to carry forward:** `grammers`' maintainer states the crypto/
auth code has **not been formally audited**. He trusts it and uses it
himself, but recommends anyone using it somewhere security-critical review
`grammers-crypto` and the auth portion of `grammers-mtproto` personally.
Given this app handles a real account login, treat session secrets with
care (see §10) and don't treat this library as beyond scrutiny just because
it's the most established option.

## 7. Tech stack

- **Shell:** Tauri v2 (check `https://v2.tauri.app` for current setup — the
  scaffolding CLI (`npm create tauri-app@latest`) always pulls the current
  version, so don't hardcode a version number)
- **Backend:** Rust, async via `tokio`
- **Telegram client:** `grammers-client` / `grammers-mtproto` / `grammers-session`
  — pin via git dependency, e.g.:
  ```toml
  [dependencies]
  grammers-client = { git = "https://github.com/Lonami/grammers", rev = "<pin to a specific commit>" }
  tokio = { version = "1", features = ["full"] }
  ```
  (Canonical repo is `codeberg.org/Lonami/grammers`; the GitHub URL above is
  a mirror — use whichever your build environment can reach. **Pin to a
  commit, not a floating branch** — releases are infrequent and the
  maintainer warns traits aren't always stable across versions.)
- **Frontend:** plain HTML/TypeScript + Vite (no heavy framework needed for
  a login screen + file list + download queue) — swap for React/Svelte if
  preferred, doesn't affect the architecture
- **Session storage:** local, encrypted at rest (see §10)

## 8. Repo structure

```
telewire/
├── CLAUDE.md                 ← this file, repo root
├── README.md                 ← user-facing readme (quick start, screenshots)
├── LICENSE                   ← MIT
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── telegram/
│       │   ├── mod.rs
│       │   ├── auth.rs       ← login flow, session persistence
│       │   ├── channel.rs    ← resolve channel, paginate media messages
│       │   └── download.rs   ← chunked parallel download engine
│       └── commands.rs       ← #[tauri::command] functions exposed to the UI
├── src/                       ← frontend
│   ├── index.html
│   ├── main.ts
│   ├── views/
│   │   ├── login.ts
│   │   ├── browser.ts        ← channel/media list UI
│   │   └── downloads.ts      ← queue + progress UI
│   └── styles.css
├── package.json
└── vite.config.ts

docs/                          ← GitHub Pages landing page (Phase "whenever",
                                  static only, no functionality — see §13)
```

## 9. Tauri command API (the contract between Rust and the UI)

Design the frontend/backend boundary around these commands (names
illustrative, adjust as needed):

| Command | Direction | Purpose |
|---|---|---|
| `login_start(phone, api_id, api_hash)` | UI → Rust | Begins auth, triggers code request |
| `login_submit_code(code)` | UI → Rust | Submits the SMS/app code |
| `login_submit_password(password)` | UI → Rust | 2FA password if enabled |
| `get_saved_session()` | UI → Rust | Checks for a cached session on launch |
| `resolve_channel(username_or_link)` | UI → Rust | Resolves a channel, returns basic info |
| `list_media(channel_id, offset, limit)` | UI → Rust | Paginated media listing (name, type, size, date, message_id) |
| `start_download(message_id, dest_path, concurrency)` | UI → Rust | Kicks off a chunked parallel download |
| `pause_download` / `resume_download` / `cancel_download(job_id)` | UI → Rust | Queue control |
| `download_progress` (event) | Rust → UI | Emitted periodically: `{ job_id, bytes_done, bytes_total, speed_bps }` |
| `download_complete` / `download_error` (event) | Rust → UI | Terminal states |

## 10. Session & security handling

- `api_id` / `api_hash`: entered once on first run, stored locally — **never**
  committed to the repo, **never** shared across users.
- Session string (proves the login without re-entering a code): store it
  **encrypted at rest**, not as plaintext in app-data. Options, roughly in
  order of effort:
  1. OS keychain via the `keyring` crate (Windows Credential Manager /
     macOS Keychain / Linux Secret Service) — simplest, most idiomatic.
  2. `tauri-plugin-stronghold` if a cross-platform vault file is preferred
     over OS-native keychains.
- Restrict any on-disk session file to owner-only permissions regardless of
  which option is chosen.
- Never log the session string, api_hash, or 2FA password, even at debug
  log levels.

## 11. Download engine design (the core of v1)

1. Get file size from the message's media metadata (`document.size` etc.)
   via `grammers`.
2. Preallocate the destination file to full size on disk (`set_len`) so
   workers can write to independent byte offsets without contention.
   Download to a `.part` file; atomically rename to the final filename
   **only** on verified completion (step 9). A file with the real name on
   disk should always mean "this is complete and correct" — never leave a
   half-downloaded file wearing its final name.
3. Split the file into N byte ranges (N = configurable concurrency, sensible
   default ~4–8).
   - **Verify current MTProto chunk-size constraints** against Telegram's
     up-to-date API docs before hardcoding a chunk size — these limits have
     shifted over time; don't assume a number from memory.
4. **Adaptive concurrency, not a fixed worker count**: track each worker's
   real measured throughput. Scale total concurrency up while marginal
   throughput keeps improving, back off if adding workers stops helping (or
   starts triggering flood-wait). This is the difference between a toy
   multi-connection downloader and one that actually outperforms a generic
   download manager.
5. **Work-stealing over static ranges**: don't just split ranges once and
   walk away. If a worker's throughput drops well below the others
   (congested path, slow edge of the DC pool, etc.), redistribute its
   *remaining* unfetched bytes to a faster worker instead of letting the
   whole download wait on the slowest one.
6. Spawn one async task per active range. Each task:
   - Opens (or reuses from a small connection pool) an authenticated
     `grammers` sender.
   - Requests sequential chunks within its assigned range via the file
     download RPC, at the offsets specific to its range.
   - Writes each chunk to the preallocated `.part` file at the correct
     offset (`seek` + `write`).
   - Reports bytes-written back through a channel for progress aggregation.
7. **Crash-safe resume**: persist a small sidecar manifest (e.g.
   `<file>.part.manifest.json`) recording which byte ranges are already
   confirmed written to disk, updated incrementally as ranges complete —
   not just held in memory. On relaunch, a `.part` file with a manifest
   resumes from exactly where it left off instead of restarting or, worse,
   silently corrupting. Delete the manifest alongside the `.part` file once
   the final rename happens.
8. **Respectful rate limiting**: this runs on a real personal account, not
   a bot — sane default concurrency plus a visible advanced setting protects
   the user from tripping flood-wait or looking like abusive traffic. On a
   flood-wait error, read the wait duration from the error, back off that
   task specifically, then resume — don't kill the whole job.
9. Aggregate all tasks' progress into one `download_progress` event stream
   emitted to the UI at a reasonable interval (e.g. every 250–500ms, not
   every chunk — avoid flooding the IPC bridge).
10. On completion, verify total bytes written equals the expected file
    size, then atomically rename `.part` → final filename and delete the
    manifest.

**Auto-organize destinations**: unless the user picks an explicit path,
save into `<downloads-root>/<channel-name>/<year>-<month>/<filename>` so a
channel's media doesn't all land in one flat, unsorted folder.

## 12. Legal, privacy & responsible-use note

This is a general-purpose tool: what a person points it at is on them. Worth
a short, plain section in the README (not preachy, just clear) noting that
users are responsible for having the right to download and use whatever
content they access with their own account — same expectation as using
Telegram's official client.

**Zero telemetry, stated explicitly.** This app logs into someone's real
Telegram account — "nothing phones home" is a genuine trust signal here, not
boilerplate. State it plainly in the README: no analytics, no crash
reporting to a third party by default, no network calls other than to
Telegram's own servers and (optionally) the update-check endpoint (§19).
If crash/usage reporting is ever added, it should be explicit opt-in, not
a default.

## 13. Parked: GitHub Pages component

Per current scope, this is a static landing/docs page only — no app logic
lives here. When picked up:
- What the app is, screenshots, download links to GitHub Releases
  (per-OS installers built via Tauri's bundler)
- No functionality, no data, nothing dynamic — can be built anytime without
  touching the app itself

## 14. Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | Auth | Phone/code/2FA login works; session persists across restarts |
| M2 | Channel browse | Paginated media list renders for a real public channel |
| M3 | Single-file download | One file downloads correctly, byte-for-byte, with a progress bar |
| M4 | Parallel chunking | Same download, but with concurrent range-fetches, and measurably faster than M3 |
| M5 | Queue + pause/resume/cancel | Multiple files queue, and downloads can be paused/resumed/cancelled cleanly |
| M6 | Resilience | Killing the app mid-download and relaunching resumes correctly from the manifest; adaptive concurrency measurably adjusts worker count; auto-organize folders land files correctly |
| M7 | Packaging | `tauri build` produces working installers for Windows/macOS/Linux |

## 15. Open questions / risks to revisit during implementation

- Exact current MTProto file-chunk size bounds (verify against live docs,
  don't hardcode from memory).
- `grammers` API surface may shift between versions — pin to a commit and
  re-verify before bumping.
- Multi-connection chunking concurrency limits before triggering
  flood-wait — needs empirical tuning, not a guessed constant.
- Code-signing for macOS/Windows installers (unsigned builds trigger OS
  warnings) — decide whether to pursue signing certificates later.

## 16. Using installed skills

Claude Code has task-specific skills available — check for them before
starting each kind of work, the same way this plan itself was produced by
consulting relevant skills before writing anything:

- **Before any UI work** (login screen, media browser, download queue,
  settings): view the `frontend-design` skill's `SKILL.md` first. Its whole
  purpose is preventing the generic AI-template look (the cream+serif look,
  the near-black+neon-accent look, the broadsheet-grid look — all listed
  explicitly in the skill as defaults to avoid). Run its actual process:
  brainstorm a token system (color/type/layout/signature), critique it
  against generic defaults, *then* build. §17 below is a seed for that
  brainstorm, not a substitute for it.
- **Before writing tests**, check for a testing-strategy skill.
- **Before a PR/code review pass**, check for a code-review skill.
- **Before writing the README or any other docs**, check for a
  documentation skill.
- More generally: before producing any file or writing any non-trivial
  code, scan whatever skills are available and read anything plausibly
  relevant — this is cheap and consistently improves output quality.

## 17. Design direction — modern, fast, distinctive

This is a **seed for the frontend-design skill's brainstorm step**, grounded
in what this app actually is, not a locked-in final spec. Push back on any
part of it that the skill's own critique step flags as generic.

**Ground it in the subject.** The entire premise of this app is a direct,
unbroken wire between the user's machine and Telegram's data centers — no
middleman, nothing in between. The visual language should say that
literally, not abstractly:

- **Signature element**: a live "wire" motif — a thin pulse/signal line
  that visibly animates during an active transfer, near the progress
  indicator. It should read as *real* activity (tied to actual throughput),
  not ambient decoration.
- **Color**: reach for something other than the default near-black +
  neon-green/vermilion combination most AI-generated dark UIs land on.
  A vintage terminal/telegraph-sounder palette (deep ink navy, warm
  amber/phosphor accent, a cool cyan for "connected" states) fits the
  subject and is genuinely distinctive.
- **Typography**: pair a monospace face for data-dense content (file
  manifests — name, size, type, speed, ETA) with a clean geometric sans for
  headings and labels. The monospace choice isn't decorative here — file
  listings are, functionally, a manifest/ledger, so let them look like one.
- **Structure**: if numbering or ordering appears in the file list, it
  should encode something real (e.g. chronological position in the
  channel), not decorative markers.
- **Motion**: purposeful only. Smooth virtualized-list scrolling, a
  satisfying (not gratuitous) download-complete micro-interaction, respect
  `prefers-reduced-motion`. Cut anything that doesn't serve the interface.

**Performance is part of the design, not separate from it:**
- Virtualize/window any list that could hold hundreds or thousands of
  files — never render the full DOM for a large channel at once.
- Lazy-load thumbnails/previews; never block the list on them.
- Batch progress-event updates to the UI (e.g. every 250–500ms) rather than
  per-chunk, so the interface stays smooth under heavy parallel downloads.
- Keep the frontend dependency footprint light — this is a native app;
  it should launch and feel instant, not carry web-app startup weight.
- Visible keyboard focus states throughout; verify the layout down to a
  reasonably small window size, not just a fixed desktop viewport.

## 18. Phase 2 — Stretch goals

Deliberately **not** in v1 — genuinely valuable, but folding them in now is
exactly the scope-creep risk this plan already warns against elsewhere.
Treat this as an intentional backlog, not a wishlist to sneak into v1.

- **Cross-channel search**: search by filename/type/date across every
  joined channel at once, not one at a time. Most clones don't bother —
  this is a real differentiator.
- **Duplicate detection**: use Telegram's file unique-ID to flag files
  already on disk, so re-browsing a channel doesn't invite re-downloading
  the same thing.
- **Live per-connection throughput graph**: a small real-time graph of
  each parallel worker's speed — a literal, functional payoff for the
  "wire" design motif in §17, not decoration.
- **CI-built, signed/notarized installers**: a release pipeline that
  builds and signs installers for all three OSes on every tag. This alone
  is what makes a project feel like a real shipped product instead of
  "clone the repo and compile it yourself."
- **Built-in auto-updater**: Tauri ships one — wire it up so fixes reach
  people without a manual reinstall. Pairs naturally with the CI/signing
  pipeline above.
- **Debug bundle export**: one button that packages sanitized logs (no
  secrets, no session data) for bug reports — makes community
  contributions and triage far easier.

## 19. License

MIT (compatible with `grammers`' MIT/Apache-2.0 dual license).
