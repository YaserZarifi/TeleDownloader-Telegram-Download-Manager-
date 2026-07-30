/**
 * TeleWire — application entry point.
 *
 * Responsibilities, and deliberately nothing else:
 *   - decide between the login flow and the main shell from the auth state
 *   - own the single source of truth for jobs, and fan updates out to views
 *   - keep the wire fed with real aggregate throughput
 *
 * All Telegram work happens in Rust. This file never sees a session string,
 * an api_hash, or a byte of file content.
 */

import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";

import type {
  AuthState,
  ChannelInfo,
  ChatKind,
  Job,
  JobState,
  ProgressBatch,
  Settings,
} from "./lib/types";
import * as ipc from "./lib/ipc";
import { icon } from "./lib/icons";
import { debounce, el, modal, must, toast } from "./lib/ui";
import { speed } from "./lib/format";
import { createWire, type Wire } from "./wire";
import { createLogin } from "./views/login";
import { createBrowser, type BrowserView } from "./views/browser";
import { createDownloads, type DownloadsView } from "./views/downloads";
import { openSettings } from "./views/settings";

const root = must("#root");

/* ------------------------------------------------------------------ state */

/** Jobs, keyed by id. The views render from this; nothing else owns it. */
const jobs = new Map<string, Job>();
/** Rail contents, in display order. Kept here rather than read back out of the
 *  DOM so adding a channel doesn't have to re-parse rendered markup. */
let channels: ChannelInfo[] = [];
/** Lower-cased rail filter, applied to title and @username. */
let railQuery = "";
/** Active folder tab. "all" shows every chat, grouped by kind. */
let railFolder: ChatKind | "all" = "all";
let railFolderStrip: HTMLElement | null = null;
let railFolderFades: (() => void) | null = null;
/** Which channel the browser is showing, so the rail can survive re-renders. */
let selectedChannelId: number | null = null;
let settings: Settings | null = null;
let wire: Wire | null = null;
let browser: BrowserView | null = null;
let downloads: DownloadsView | null = null;
let unlisten: Array<() => void> = [];

/** `channel_id:message_id` → state, so the file list can mark rows already
 *  queued or downloaded without scanning the whole job map per row. */
function jobStateIndex(): Map<string, JobState> {
  const map = new Map<string, JobState>();
  for (const j of jobs.values()) map.set(`${j.channel_id}:${j.message_id}`, j.state);
  return map;
}

/* ------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  try {
    const state = await ipc.getAuthState();
    route(state);
  } catch (e) {
    // Failing to even ask the backend is fatal enough to say so plainly rather
    // than dropping the user into a login form that cannot work.
    root.replaceChildren(
      el("div.auth", {}, [
        el("div.auth-card.panel", {}, [
          el("div.auth-brand", {}, [
            el("span", { html: icon("alert", 28) }),
            el("h1", {}, "BACKEND UNREACHABLE"),
            el("p.selectable", {}, e instanceof Error ? e.message : String(e)),
          ]),
        ]),
      ])
    );
  }
}

function route(state: AuthState): void {
  teardown();
  if (state.stage === "ready") {
    void mountShell(state);
  } else {
    const login = createLogin({ onAuthenticated: (next) => route(next) });
    login.setState(state);
    root.replaceChildren(login.el);
  }
}

function teardown(): void {
  for (const off of unlisten) off();
  unlisten = [];
  wire?.destroy();
  browser?.destroy();
  downloads?.destroy();
  wire = null;
  browser = null;
  downloads = null;
}

/* ------------------------------------------------------------------ shell */

async function mountShell(auth: Extract<AuthState, { stage: "ready" }>): Promise<void> {
  /* --- masthead --- */
  const linkState = el("div.link-state", { "data-state": "online", title: "Connection to Telegram" }, [
    el("span.link-dot"),
    el("span", {}, "Linked"),
  ]);

  const settingsBtn = el("button.btn-icon", {
    type: "button",
    "aria-label": "Settings",
    title: "Settings",
    html: icon("settings", 17),
  }) as HTMLButtonElement;

  const logoutBtn = el("button.btn-icon", {
    type: "button",
    "aria-label": `Sign out of ${auth.user.first_name}'s account`,
    title: "Sign out",
    html: icon("logout", 17),
  }) as HTMLButtonElement;

  const masthead = el("header.masthead", {}, [
    el("div.brand", {}, [
      el("span", { html: icon("wire", 20) }),
      el("b", {}, "TELE"),
      el("span", {}, "WIRE"),
    ]),
    el("div.masthead-spacer"),
    ipc.isDemo()
      ? el("div.link-state", { "data-state": "offline", title: "Fixture data — no Telegram connection" }, [
          el("span.link-dot"),
          el("span", {}, "Demo data"),
        ])
      : null,
    linkState,
    settingsBtn,
    logoutBtn,
  ]);

  /* --- the wire --- */
  const canvas = el("canvas", { "aria-hidden": "true" }) as HTMLCanvasElement;
  const rate = el("b", {}, "0 B/s");
  const activeCount = el("span.wire-peak", {}, "idle");
  const wireBar = el("div.wire", {}, [
    canvas,
    el("div.wire-readout", {}, [activeCount, el("span", {}, "·"), rate]),
  ]);

  /* --- rail --- */
  const railList = el("div.rail-scroll", { role: "list", "aria-label": "Channels" });
  const addBtn = el("button.btn.btn-ghost", { type: "button", style: "width:100%; justify-content:flex-start" }, [
    el("span", { html: icon("plus", 15) }),
    el("span", {}, "Add channel"),
  ]) as HTMLButtonElement;

  const railSearch = el("input.input", {
    type: "search",
    placeholder: "Filter channels",
    "aria-label": "Filter channels",
    spellcheck: "false",
  }) as HTMLInputElement;
  const railSearchBox = el("div.search", {}, [railSearch]);
  railSearchBox.insertAdjacentHTML("afterbegin", icon("search", 14));

  // Filtering is local to the already-loaded list, so it can run on every
  // keystroke without a round-trip; the debounce only spares the DOM work.
  railSearch.addEventListener(
    "input",
    debounce(() => {
      railQuery = railSearch.value.trim().toLowerCase();
      renderChannels(railList);
    }, 120)
  );

  const resizer = el("div.rail-resizer", {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize the chat list",
    tabindex: "0",
    title: "Drag to resize",
  });

  // Telegram-style folder tabs. A horizontally scrolling strip rather than a
  // wrapping row, so a narrow rail never turns into three lines of chrome.
  // Explicit type argument: `el`'s tag parameter can't be inferred from a
  // string, so without it the return type is a union of every element and
  // `addEventListener("wheel", …)` won't resolve to the WheelEvent overload.
  const folderStrip = el<"div">("div.folders", {
    role: "tablist",
    "aria-label": "Chat folders",
  });
  railFolderStrip = folderStrip;

  // A vertical wheel does nothing to a horizontally-scrolling strip, so tabs
  // past the edge felt unreachable even though the container did scroll.
  // Translate wheel movement onto the horizontal axis.
  folderStrip.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      const max = folderStrip.scrollWidth - folderStrip.clientWidth;
      if (max <= 0) return;
      e.preventDefault();
      folderStrip.scrollLeft += delta;
    },
    { passive: false }
  );

  // Show a fade only on the side that is actually cut off.
  const syncFolderFades = () => {
    const max = folderStrip.scrollWidth - folderStrip.clientWidth;
    folderStrip.dataset.overflowLeft = String(folderStrip.scrollLeft > 2);
    folderStrip.dataset.overflowRight = String(folderStrip.scrollLeft < max - 2);
  };
  folderStrip.addEventListener("scroll", syncFolderFades, { passive: true });
  new ResizeObserver(syncFolderFades).observe(folderStrip);
  railFolderFades = syncFolderFades;

  const rail = el("nav.rail", {}, [
    el("div.rail-head", {}, [railSearchBox, folderStrip]),
    railList,
    el("div.rail-foot", {}, [addBtn]),
    resizer,
  ]);

  /* --- main panes --- */
  browser = createBrowser({
    onEnqueue: (channelId, messageIds) => void enqueue(channelId, messageIds),
  });
  downloads = createDownloads({
    onPause: (id) => void guard(() => ipc.pauseDownload(id)),
    onResume: (id) => void guard(() => ipc.resumeDownload(id)),
    onCancel: (id) => void guard(() => ipc.cancelDownload(id)),
    onRetry: (id) => void guard(() => ipc.retryDownload(id)),
    onReveal: (path) => void guard(() => ipc.revealInFolder(path)),
    onClearFinished: () =>
      void guard(async () => {
        await ipc.clearFinished();
        await refreshJobs();
      }),
  });

  const queuePill = el("span.count-pill", {}, "0");
  const tabBrowse = el("button.tab", { type: "button", role: "tab", "aria-selected": "true" }, [
    el("span", { html: icon("inbox", 14) }),
    el("span", {}, "Library"),
  ]) as HTMLButtonElement;
  const tabQueue = el("button.tab", { type: "button", role: "tab", "aria-selected": "false" }, [
    el("span", { html: icon("download", 14) }),
    el("span", {}, "Transfers"),
    queuePill,
  ]) as HTMLButtonElement;

  const paneHost = el("div.main#main-region", { role: "main" });
  const tabs = el("div.tabs", { role: "tablist", "aria-label": "Views", style: "max-width:320px" }, [
    tabBrowse,
    tabQueue,
  ]);

  const showPane = (which: "browse" | "queue") => {
    tabBrowse.setAttribute("aria-selected", String(which === "browse"));
    tabQueue.setAttribute("aria-selected", String(which === "queue"));
    paneHost.replaceChildren(
      el("div.toolbar", {}, [tabs]),
      which === "browse" ? browser!.el : downloads!.el
    );
  };
  tabBrowse.addEventListener("click", () => showPane("browse"));
  tabQueue.addEventListener("click", () => showPane("queue"));

  const app = el("div#app", {}, [
    el("a.skip-link.sr-only", { href: "#main-region" }, "Skip to content"),
    masthead,
    wireBar,
    el("div.workspace", {}, [rail, paneHost]),
  ]);
  root.replaceChildren(app);
  showPane("browse");
  installRailResize(app, resizer);

  wire = createWire(canvas);
  wire.setState("online");

  /* --- data --- */
  settings = (await guard(() => ipc.getSettings())) ?? null;
  settingsBtn.addEventListener("click", () => {
    if (!settings) return;
    openSettings(settings, (next) => (settings = next));
  });

  logoutBtn.addEventListener("click", async () => {
    const next = await guard(() => ipc.logout());
    if (next) route(next);
  });

  await loadChannels(railList);
  addBtn.addEventListener("click", () => promptChannel(railList));
  await refreshJobs();

  /* --- live updates --- */
  const applyQueueBadge = () => {
    const live = [...jobs.values()].filter(
      (j) => j.state === "running" || j.state === "queued" || j.state === "paused"
    ).length;
    queuePill.textContent = String(live);
    queuePill.setAttribute("data-active", String(live > 0));
  };

  unlisten.push(
    await ipc.on<ProgressBatch>(ipc.EV.progress, (batch) => {
      for (const p of batch.jobs) {
        const j = jobs.get(p.id);
        if (!j) continue;
        Object.assign(j, p);
      }
      downloads?.applyProgress(batch);

      // Feed the real number to the wire and the readout. This is the only
      // driver of that animation — nothing about it is decorative.
      wire?.setThroughput(batch.total_bps);
      wire?.setState(batch.total_bps > 0 ? "transfer" : "online");
      linkState.setAttribute("data-state", batch.total_bps > 0 ? "transfer" : "online");
      rate.textContent = speed(batch.total_bps);
      const n = batch.jobs.length;
      activeCount.textContent = n === 0 ? "idle" : `${n} active`;
    })
  );

  unlisten.push(
    await ipc.on<Job>(ipc.EV.job, (job) => {
      jobs.set(job.id, job);
      downloads?.render([...jobs.values()]);
      browser?.setJobStates(jobStateIndex());
      applyQueueBadge();
    })
  );

  unlisten.push(
    await ipc.on<AuthState>(ipc.EV.auth, (state) => {
      if (state.stage !== "ready") route(state);
    })
  );

  applyQueueBadge();

  /* --- global shortcuts --- */
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "1") showPane("browse");
    if (e.key === "2") showPane("queue");
  };
  document.addEventListener("keydown", onKey);
  unlisten.push(() => document.removeEventListener("keydown", onKey));
}

/* --------------------------------------------------------------- channels */

async function loadChannels(host: HTMLElement): Promise<void> {
  host.replaceChildren(el("div.field-hint", { style: "padding:12px" }, "Loading channels…"));
  const list = await guard(() => ipc.listDialogs());
  if (!list) {
    host.replaceChildren(el("div.field-hint", { style: "padding:12px" }, "Couldn't load your channels."));
    return;
  }
  channels = list;
  if (railFolderStrip) renderFolders(railFolderStrip);
  renderChannels(host);
}

/** Folder order. Saved leads because it is the account's own file store. */
const FOLDERS: Array<{ id: ChatKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "saved", label: "Saved" },
  { id: "channel", label: "Channels" },
  { id: "group", label: "Groups" },
  { id: "bot", label: "Bots" },
  { id: "person", label: "People" },
];

function renderFolders(host: HTMLElement): void {
  host.replaceChildren();
  for (const f of FOLDERS) {
    const n = f.id === "all" ? channels.length : channels.filter((c) => c.kind === f.id).length;
    // An empty folder is noise — Telegram hides them too. "All" always shows.
    if (n === 0 && f.id !== "all") continue;

    const tab = el("button.folder", {
      type: "button",
      role: "tab",
      "aria-selected": String(railFolder === f.id),
    }, [
      el("span", {}, f.label),
      el("span.count-pill", {}, String(n)),
    ]);
    tab.addEventListener("click", () => {
      railFolder = f.id;
      renderFolders(host);
      renderChannels(must(".rail-scroll"));
      // Bring a partly-clipped tab fully into view once it becomes the
      // selection, so the active folder is never the one hidden by a fade.
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    host.append(tab);
  }
  railFolderFades?.();
}

function renderChannels(host: HTMLElement): void {
  host.replaceChildren();

  if (!channels.length) {
    host.append(
      el("div.rail-empty", {}, "No chats yet. Use “Add channel” to open one by @username.")
    );
    return;
  }

  const matches = channels
    .filter((c) => railFolder === "all" || c.kind === railFolder)
    .filter(
      (c) =>
        !railQuery ||
        c.title.toLowerCase().includes(railQuery) ||
        (c.username ?? "").toLowerCase().includes(railQuery)
    );

  if (!matches.length) {
    host.append(
      el(
        "div.rail-empty",
        {},
        railQuery ? `No chat matches “${railQuery}”.` : "Nothing in this folder."
      )
    );
    return;
  }

  // Inside a specific folder the rows are already homogeneous, so the group
  // headings would just repeat the selected tab. They only earn their place
  // in "All".
  if (railFolder !== "all") {
    renderChannelRows(host, matches);
    return;
  }

  for (const f of FOLDERS) {
    if (f.id === "all") continue;
    const list = matches.filter((c) => c.kind === f.id);
    if (!list.length) continue;
    host.append(
      el("div.rail-group", {}, [
        el("span.eyebrow", {}, f.label),
        el("span.count-pill", {}, String(list.length)),
      ])
    );
    renderChannelRows(host, list);
  }
}

/* ----------------------------------------------------------- rail resizing */

const RAIL_MIN = 180;
const RAIL_MAX = 460;
const RAIL_KEY = "telewire.railWidth";

/**
 * Drag (or arrow-key) the divider to resize the chat list. Width is written to
 * the `--rail-w` custom property that the workspace grid already reads, so
 * resizing costs one style recalculation and no layout thrash — and the
 * responsive rules that collapse the rail on narrow windows keep working.
 */
function installRailResize(app: HTMLElement, handle: HTMLElement): void {
  const apply = (px: number, persist = true) => {
    const clamped = Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, px)));
    app.style.setProperty("--rail-w", `${clamped}px`);
    handle.setAttribute("aria-valuenow", String(clamped));
    if (persist) localStorage.setItem(RAIL_KEY, String(clamped));
    return clamped;
  };

  const saved = Number(localStorage.getItem(RAIL_KEY));
  if (Number.isFinite(saved) && saved > 0) apply(saved, false);

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = "true";
    // Suppress text selection and hover effects for the duration of the drag.
    document.body.style.cursor = "col-resize";

    const onMove = (ev: PointerEvent) => {
      // The rail starts at the window's left edge, so the pointer's x is the
      // width directly — no need to measure the rail every frame.
      apply(ev.clientX);
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      delete handle.dataset.dragging;
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });

  // Keyboard equivalent — a mouse-only resizer is not operable per WCAG.
  handle.addEventListener("keydown", (e) => {
    const current = parseInt(getComputedStyle(app).getPropertyValue("--rail-w"), 10) || 232;
    const step = e.shiftKey ? 40 : 12;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      apply(current - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      apply(current + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      apply(232);
    }
  });

  handle.setAttribute("aria-valuemin", String(RAIL_MIN));
  handle.setAttribute("aria-valuemax", String(RAIL_MAX));
}

/* ---------------------------------------------------------------- avatars */

/** Data URIs already fetched this session, so re-rendering the rail (which the
 *  search box does on every keystroke) never refetches. */
const avatarCache = new Map<number, string | null>();
const avatarQueue: Array<{ ch: ChannelInfo; host: HTMLElement }> = [];
let avatarWorkers = 0;

/**
 * Avatar fetching is throttled to a few at a time. Each one is a real file
 * download from Telegram, and firing 120 of them the moment the rail renders
 * would compete with the download engine for the same connection pool — the
 * one thing this app must never make slower.
 */
function queueAvatar(ch: ChannelInfo, host: HTMLElement): void {
  const cached = avatarCache.get(ch.id);
  if (cached !== undefined) {
    if (cached) paintAvatar(host, cached);
    return;
  }
  avatarQueue.push({ ch, host });
  pumpAvatars();
}

function pumpAvatars(): void {
  while (avatarWorkers < 3 && avatarQueue.length) {
    const next = avatarQueue.shift();
    if (!next) return;
    avatarWorkers++;
    void ipc
      .getChatPhoto(next.ch.id)
      .then((uri) => {
        avatarCache.set(next.ch.id, uri);
        if (uri) paintAvatar(next.host, uri);
      })
      // A missing avatar is not worth a toast; the initials are a fine result.
      .catch(() => avatarCache.set(next.ch.id, null))
      .finally(() => {
        avatarWorkers--;
        pumpAvatars();
      });
  }
}

function paintAvatar(host: HTMLElement, uri: string): void {
  // The node may have been replaced by a re-render while the fetch was in
  // flight; writing into a detached node is harmless but pointless.
  if (!host.isConnected) return;
  host.replaceChildren(el("img", { src: uri, alt: "" }));
}

function renderChannelRows(host: HTMLElement, list: ChannelInfo[]): void {
  for (const ch of list) {
    const initials = ch.title.trim().slice(0, 2).toUpperCase() || "??";
    const avatar = el("span.chan-avatar", { "data-saved": ch.kind === "saved" ? "true" : null }, [
      ch.photo
        ? el("img", { src: ch.photo, alt: "" })
        : ch.kind === "saved"
          // Saved Messages has no avatar and its initials would be meaningless.
          ? el("span", { html: icon("inbox", 15) })
          : el("span", {}, initials),
    ]);
    // Real avatars are fetched lazily so opening the app isn't N downloads.
    // The initials stay visible until one actually arrives, so a chat without
    // a photo never shows a hole.
    if (!ch.photo && ch.kind !== "saved") queueAvatar(ch, avatar);
    const btn = el("button.chan", {
      type: "button",
      role: "listitem",
      title: ch.title,
      "aria-current": ch.id === selectedChannelId ? "true" : null,
    }, [
      avatar,
      el("span.chan-text", {}, [
        el("span.chan-name", { text: ch.title }),
        el("span.chan-meta", {
          text:
            ch.kind === "saved"
              ? "your own files"
              : ch.username
                ? `@${ch.username}`
                : ch.participants
                  ? `${ch.participants.toLocaleString()} members`
                  : ch.kind,
        }),
      ]),
    ]);
    btn.addEventListener("click", () => {
      // Selection is tracked in state, not just in the DOM, so it survives the
      // re-render that filtering causes.
      selectedChannelId = ch.id;
      for (const other of host.querySelectorAll(".chan")) other.removeAttribute("aria-current");
      btn.setAttribute("aria-current", "true");
      browser?.setChannel(ch);
      browser?.setJobStates(jobStateIndex());
    });
    host.append(btn);
  }
}

/** Resolve a channel by @username or t.me link and prepend it to the rail. */
function promptChannel(host: HTMLElement): void {
  const input = el("input.input", {
    id: "chan-query",
    placeholder: "@channelname or https://t.me/…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const status = el("div.field-hint", {}, "");
  const go = el("button.btn.btn-primary", { type: "button" }, "Open") as HTMLButtonElement;

  const body = el("div", {}, [
    el("div.modal-head", {}, [
      el("span", { html: icon("search", 18) }),
      el("div.modal-title", {}, [
        el("h2", { id: "add-title" }, "Open a channel"),
        el("p.field-hint", {}, "Anything your account can already read."),
      ]),
    ]),
    el("div.field", {}, [el("label", { for: "chan-query" }, "Channel"), input, status]),
    el("div.modal-foot", {}, [go]),
  ]);

  const close = modal(body, { labelledBy: "add-title" });

  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    go.disabled = true;
    status.textContent = "Resolving…";
    try {
      const ch = await ipc.resolveChannel(q);
      close();
      // Move an already-listed channel to the top rather than duplicating it,
      // and clear any filter that would hide the thing just added.
      channels = [ch, ...channels.filter((c) => c.id !== ch.id)];
      // Clear any filter or folder that would hide the thing just added.
      railQuery = "";
      railFolder = "all";
      selectedChannelId = ch.id;
      if (railFolderStrip) renderFolders(railFolderStrip);
      renderChannels(host);
      browser?.setChannel(ch);
      browser?.setJobStates(jobStateIndex());
    } catch (e) {
      status.textContent = "";
      go.disabled = false;
      status.replaceChildren(
        el("span.field-error", {}, e instanceof Error ? e.message : String(e))
      );
    }
  };

  go.addEventListener("click", () => void run());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void run();
  });
}

/* ------------------------------------------------------------------- jobs */

async function refreshJobs(): Promise<void> {
  const list = await guard(() => ipc.listJobs());
  if (!list) return;
  jobs.clear();
  for (const j of list) jobs.set(j.id, j);
  downloads?.render([...jobs.values()]);
  browser?.setJobStates(jobStateIndex());
}

async function enqueue(channelId: number, messageIds: number[]): Promise<void> {
  const created = await guard(() => ipc.enqueueDownload(channelId, messageIds));
  if (!created) return;
  // Insert only what we haven't already heard about. The command's return
  // value is a snapshot taken at creation time (state "queued"), but the
  // backend starts the job and emits the "running" event before the call even
  // resolves — writing the snapshot over that would roll the row back to
  // queued, which is why running transfers were showing the queued action set
  // (cancel only, no pause). Events are always the fresher source.
  for (const j of created) if (!jobs.has(j.id)) jobs.set(j.id, j);
  downloads?.render([...jobs.values()]);
  browser?.setJobStates(jobStateIndex());
  toast(
    created.length === 1 ? `Queued ${created[0].name}` : `Queued ${created.length} files`,
    "ok"
  );
}

/* ------------------------------------------------------------------ utils */

/** Run a backend call, surface any failure as a toast, return undefined on
 *  error so callers can bail without a try/catch at every site. */
async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return undefined;
  }
}

void boot();
