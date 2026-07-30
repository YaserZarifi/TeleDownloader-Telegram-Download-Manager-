# TeleWire — working notes

Desktop Telegram download manager. Tauri v2 shell, Rust backend that *is* an
MTProto client (`grammers` 0.10), plain-TypeScript frontend on Vite.

`Plan.md` is the original design doc. It is **partly out of date** — read it
for intent, not for API detail. Where they disagree, the code wins; the known
deviations are listed at the bottom of this file.

---

## Architecture

```
┌─ src/ ─────────────────────┐   Tauri IPC    ┌─ src-tauri/ ──────────────┐
│ index.html, main.ts        │ ◄────────────► │ commands.rs               │
│ views/  login browser      │  commands +    │ telegram/  mod auth       │
│         downloads settings │  3 events      │            channel        │
│ lib/    types ipc ui       │                │            download       │
│         icons format demo  │                │ model.rs  store.rs        │
│ wire.ts styles.css         │                └───────────┬───────────────┘
└────────────────────────────┘                            │ MTProto
                                                          ▼
                                                 Telegram data centers
```

No server, no bot, no relay anywhere. The webview never makes a network
request — it is CSP-locked and even its fonts are bundled.

## Module map

| Path | Responsibility |
|---|---|
| `src-tauri/src/lib.rs` | Builder, plugin + command registration, `TELEWIRE_PROBE` diagnostic mode |
| `src-tauri/src/commands.rs` | Every `#[tauri::command]`. All return `Result<T, String>` formatted with `{:#}` so anyhow context survives |
| `src-tauri/src/model.rs` | Serde types — **the wire contract** |
| `src-tauri/src/store.rs` | Keychain (`api_hash`), settings JSON, session path, embedded build-time credentials |
| `src-tauri/src/telegram/mod.rs` | Client lifecycle, login flow, peer/title/photo caches |
| `src-tauri/src/telegram/channel.rs` | Dialog listing, username resolution, media paging, avatars |
| `src-tauri/src/telegram/download.rs` | The engine. Read its module comment first |
| `src/main.ts` | Shell, job state, rail (search / categories / resize / avatars) |
| `src/views/browser.ts` | Virtualized file manifest, paging, selection, skeletons |
| `src/views/downloads.ts` | Queue rows, reconciliation, 400 ms progress hot path |
| `src/lib/demo.ts` | Fixture backend used when the page runs outside Tauri |

## The one contract rule

`src-tauri/src/model.rs` and `src/lib/types.ts` **must change together.**

A mismatch is not a compile error on either side — it surfaces as `undefined`
in the UI at runtime. Both files carry a pointer to the other. Tauri converts
camelCase command arguments to snake_case parameters automatically, so
`ipc.ts` sends `channelId` and Rust receives `channel_id`.

Events: `telewire://progress` (batched ~400 ms), `telewire://job` (state
transitions), `telewire://auth`.

## Design system (`src/styles.css`)

- **Ink navy, not near-black.** `#0b1220`, hue held ~217 across every surface.
- **Amber `#f2a93b` = bytes actually moving. Cyan `#43c6d8` = connected but
  idle.** These are load-bearing status signals. Never use them decoratively.
- **Mono for the manifest.** The file list is a ledger, so it is set in
  JetBrains Mono; Space Grotesk carries headings and labels.
- Numbering must encode something real. `.m-seq` is the Telegram message id,
  which *is* the post's ordinal position in a channel — not a row counter.
- **No emoji as icons** — everything comes from `src/lib/icons.ts` (inline SVG,
  `currentColor`).
- **No CDN fonts.** `@fontsource` packages are bundled at build time; a runtime
  font fetch would break the zero-telemetry promise.
- Respect `prefers-reduced-motion`. The wire canvas checks it directly and
  stops animating rather than relying on the CSS clamp.
- Any list that can hold thousands of rows must be virtualized.

## Download engine invariants

Do not break these without reading `download.rs` in full:

1. **The real filename only ever appears on a complete, verified file.** All
   work happens on `<name>.part`; the rename is last, after a length check.
2. **The manifest lists only chunks already flushed to disk.** It is written
   temp-file-then-rename. A crash may lose in-flight chunks, never claimed ones.
3. **Requests are 512 KiB at 512 KiB-aligned offsets.** Telegram requires the
   limit to divide 1 MiB, the offset to be a multiple of 4 KiB, and no request
   to straddle a 1 MiB boundary. This alignment satisfies all three.
4. **Work stealing is the shared chunk queue**, not static ranges. Never slice
   the file into fixed per-worker ranges.
5. **Flood-wait backs off one worker**, for exactly the duration Telegram
   reports, and the job continues.

## Build and run

```bash
npm install
npm run app       # tauri dev
npm run bundle    # installers
npm run dev       # frontend only, in a browser, on fixture data
./node_modules/.bin/tsc --noEmit   # frontend type-check
cd src-tauri && cargo build        # backend
```

Diagnostics — when a chat looks empty, do not guess:

```bash
TELEWIRE_PROBE=1 ./src-tauri/target/debug/telewire.exe
```

Walks every chat and prints, per chat, how many messages were scanned, how
many media items were found, and what was skipped and why.

Windows without MSVC: the `x86_64-pc-windows-gnu` toolchain plus MinGW-w64
works.

## Gotchas that actually bit

- **`tokio::spawn` panics inside Tauri's `setup` hook** ("there is no reactor
  running"). Use `tauri::async_runtime::spawn` there. Anywhere inside a command
  or an already-spawned task, either works.
- **`crate-type` is `["rlib"]` only.** Tauri's stock template also emits
  `cdylib`/`staticlib` for mobile; under MinGW the cdylib link fails with
  "export ordinal too large". Nothing on desktop consumes them.
- **grammers 0.10 is a rewrite of the 0.7 API.** There is no `Config`, no
  `Client::connect`, no session string, and no `types` module. Setup is
  `SenderPool::new` → `Client::new(handle)` → **you must**
  `spawn(runner.run())` or every call fails with `InvocationError::Dropped`.
- **`PeerRef` is the only way to address a chat and cannot be rebuilt from an
  `i64`**, so every resolved peer is cached in `Telegram::peers`.
- **Do not use `i64::from(PeerRef)` as a chat id.** It returns the same value
  for every chat, which collapses the peer cache onto one key and makes every
  chat display the last one's contents. Use `peer_key()` /
  `PeerId::bot_api_dialog_id()`.
- **`iter_messages` needs an explicit `.limit()`.** It is a *total* cap, and
  without it the iterator reports itself finished and returns `None` on the
  first call — every chat looks empty.
- **`RpcError::is("FLOOD_WAIT_*")` never matches.** The digits are already
  stripped into `.value`; match `is("FLOOD_WAIT")` or on `code == 420`.
- **`Media` is `#[non_exhaustive]`** — match arms need a `_`.
- **The `pump → start → finish → pump` cycle is not provably `Send`.** Queue
  promotion goes through the scheduler channel (`Engine::nudge`) to break it.
- Session and settings live in the per-user app data dir, *not* the repo.
  `src-tauri/telewire.credentials` is gitignored and must stay that way.

## Deviations from Plan.md, on purpose

| Plan says | Reality |
|---|---|
| §7 pin `grammers` to a GitHub commit | That repo was archived Feb 2026; canonical home is Codeberg. Pinned to crates.io `=0.10.0`, which is a stricter pin than a branch |
| §10 encrypt the session *string* in the keychain | grammers 0.10 has no session string. `SqliteSession` writes through to a file; we keep the `api_hash` in the keychain and tighten the session file's permissions |
| §9 `start_download(message_id, dest, concurrency)` | `enqueue_download(channelId, messageIds[])`; destination and concurrency come from settings |
| §17 seed palette | Kept ink navy + amber + cyan. Rejected the skill's glassmorphism/Inter suggestion as exactly the generic dark-UI look §17 warns against |
