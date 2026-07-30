/**
 * Browser view — the channel manifest.
 *
 * A channel can hold tens of thousands of files, so the list is virtualized:
 * `.manifest-viewport` scrolls, `.manifest-canvas` is sized to the full row
 * count, and only the visible window (plus overscan) exists as DOM. Rows are
 * recycled through a pool — allocating 20 nodes once and re-labelling them is
 * an order of magnitude cheaper than creating/destroying them per frame, and
 * it keeps GC out of the scroll path.
 *
 * Everything Telegram sends us (titles, filenames) is attacker-controlled and
 * is only ever written through `textContent` / the `text:` attribute. `html:`
 * is reserved for the icon SVG strings we ship ourselves.
 */

import type { ChannelInfo, JobState, MediaFilter, MediaItem } from "../lib/types";
import { listMedia } from "../lib/ipc";
import { bytes, date, ellipsize } from "../lib/format";
import { icon, kindIcon, type IconName } from "../lib/icons";
import { debounce, el, rafBatch, toast } from "../lib/ui";

/** Must match the `--row-h` token: the canvas height and every row offset are
 *  derived from it, so a mismatch shows up as drifting rows. */
const ROW_H = 44;
/** Rows kept mounted above and below the window. Enough to cover a fast flick
 *  between two animation frames without exposing blank space. */
const OVERSCAN = 8;
const PAGE_SIZE = 100;
/** Distance from the end of the list at which the next page is requested. */
const NEAR_BOTTOM = 600;
/** Filenames are truncated in the middle so the extension survives; the CSS
 *  ellipsis alone would eat it. */
const NAME_MAX = 80;

/** Placeholder rows drawn while page 1 is in flight. Twelve covers a ~530px
 *  viewport; the container clips whatever falls past it, so this never has to
 *  match the real height exactly. */
const SKELETON_ROWS = 12;
/** Placeholder rows parked after the last real row while a later page loads. */
const TAIL_SKELETONS = 3;
/** Name-column widths, in %. Identical bars read as one progress indicator;
 *  ragged ones read as a list of files that simply has not arrived yet. */
const SKELETON_W = [78, 52, 91, 64, 43, 85, 70, 57, 96, 61, 47, 80];
/** How many consecutive media-free pages the background pager will walk before
 *  it stops and hands the decision back to the user. The backend scans up to
 *  600 *messages* per page, so six of these is several thousand messages —
 *  long enough to clear a chatty run of text, short enough not to spin. */
const MAX_EMPTY_PAGES = 6;

const FILTERS: ReadonlyArray<{ id: MediaFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "photo", label: "Photos" },
  { id: "document", label: "Files" },
];

export interface BrowserView {
  el: HTMLElement;
  setChannel(ch: ChannelInfo | null): void;
  /** Called when job states change so rows can show DOWNLOADING / DONE etc. */
  setJobStates(map: Map<string, JobState>): void;
  destroy(): void;
}

/** A pooled row plus the values last painted into it. Comparing before writing
 *  keeps a scroll frame down to the handful of cells that actually changed. */
interface Row {
  node: HTMLElement;
  check: HTMLInputElement;
  seq: HTMLElement;
  kind: HTMLElement;
  name: HTMLElement;
  size: HTMLElement;
  when: HTMLElement;
  status: HTMLElement;
  action: HTMLElement;
  vIndex: number;
  vId: number;
  vKind: string;
  vName: string;
  vSize: number;
  vDate: number;
  vStatus: string;
  vSelected: boolean;
}

const msgOf = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : "Unexpected backend failure";

export function createBrowser(opts: {
  onEnqueue: (channelId: number, messageIds: number[]) => void;
}): BrowserView {
  /* ---------- state ------------------------------------------------------ */

  let channel: ChannelInfo | null = null;
  let filter: MediaFilter = "all";
  let query = "";

  /** Everything loaded so far for (channel, filter), oldest page first. */
  let items: MediaItem[] = [];
  /** `items` after the search box; this is what the virtualizer indexes. */
  let view: MediaItem[] = items;

  /** Cursor for the next page. `null` means end of history — never re-ask. */
  let nextOffset: number | null = 0;
  let total: number | null = null;
  let loading = false;
  let loadError: string | null = null;
  /** Consecutive pages that came back with no media but a live cursor. */
  let emptyPages = 0;
  /** True once `emptyPages` hits the cap: the automatic chain has given up,
   *  but there is still history left, so this is a pause and not an answer. */
  let stalled = false;
  /** The first cursor we saw for this (channel, filter), used to estimate how
   *  far the scan has travelled. */
  let scanFrom: number | null = null;
  /** Bumped whenever the channel or filter changes; an in-flight page whose
   *  token is stale must not touch state it no longer belongs to. */
  let token = 0;
  let dead = false;

  /** Learned per-filter totals for the current channel, for the count pills. */
  const counts = new Map<MediaFilter, number>();
  let jobStates: Map<string, JobState> = new Map();

  const selected = new Set<number>(); // message ids
  // View index that a shift-click ranges from. Both the row body and the row
  // checkbox move it, so shift-extending works across the two the way it does
  // in a file manager — the anchor is "the last row you acted on", not "the
  // last row you clicked in one particular spot".
  let anchor = -1;
  let focusIdx = -1; // view index of the roving keyboard focus

  /** Cached so neither the scroll handler nor the render loop reads layout. */
  let viewportH = 0;

  const mounted = new Map<number, Row>(); // view index -> live row
  const pool: Row[] = [];

  /* ---------- toolbar ---------------------------------------------------- */

  const titleEl = el<"h2">("h2", { text: "No channel selected" });
  const subEl = el<"div">("div.toolbar-sub.mono");

  const searchInput = el<"input">("input.input", {
    type: "search",
    placeholder: "Filter loaded files",
    "aria-label": "Filter loaded files by name",
    autocomplete: "off",
    spellcheck: "false",
  });
  const searchBox = el<"div">("div.search", {}, [searchInput]);
  // Trusted icon markup; the CSS positions the svg against `.search`.
  searchBox.insertAdjacentHTML("afterbegin", icon("search", 15));

  const tabsEl = el<"div">("div.tabs", { role: "tablist", "aria-label": "Media type" });
  const pills = new Map<MediaFilter, HTMLElement>();
  const tabs = new Map<MediaFilter, HTMLElement>();
  for (const f of FILTERS) {
    const pill = el<"span">("span.count-pill", {
      text: "—",
      "data-active": String(f.id === filter),
    });
    const tab = el<"button">(
      "button.tab",
      {
        type: "button",
        role: "tab",
        "data-f": f.id,
        // el() drops `false`, so ARIA booleans go in as strings.
        "aria-selected": String(f.id === filter),
      },
      [el<"span">("span", { text: f.label }), pill]
    );
    pills.set(f.id, pill);
    tabs.set(f.id, tab);
    tabsEl.append(tab);
  }

  const dlLabel = el<"span">("span", { text: "Download" });
  const dlBtn = el<"button">("button.btn.btn-primary", { type: "button", hidden: true }, [
    el<"span">("span", { html: icon("download", 15) }),
    dlLabel,
  ]);

  const toolbar = el<"div">("div.toolbar", {}, [
    el<"div">("div.toolbar-title", {}, [titleEl, subEl]),
    searchBox,
    tabsEl,
    dlBtn,
  ]);

  /* ---------- manifest --------------------------------------------------- */

  /* The select-all box. Unlike the per-row boxes this one is a real tab stop:
     one stop for the whole grid is cheap, and it is the only way to reach
     batch selection from the keyboard without arrowing down the whole list.
     Its checked / indeterminate state and its accessible name are both derived
     from `view` in syncChrome() — see there for why the scope matters. */
  const selectAll = el<"input">("input.cbx", {
    type: "checkbox",
    "aria-label": "Select all loaded files",
  });

  /* The head and a row share one 8-column grid, so the head must emit exactly
     eight children in row order. The three columns the responsive rules drop
     (`.m-seq`, `.m-date`, `.m-status`) carry those classes here too, otherwise
     the head would keep eight children in a five-column grid below 720px. */
  const head = el<"div">("div.manifest-head", {}, [
    el<"span">("span.m-check", {}, [selectAll]),
    el<"span">("span.m-seq", { text: "#" }),
    el<"span">("span", { "aria-hidden": "true" }),
    el<"span">("span", { text: "Name" }),
    el<"span">("span", { text: "Size" }),
    el<"span">("span.m-date", { text: "Date" }),
    el<"span">("span.m-status", { text: "Status" }),
    el<"span">("span", { "aria-hidden": "true" }),
  ]);

  const canvas = el<"div">("div.manifest-canvas", { role: "rowgroup" });
  const viewport = el<"div">(
    "div.manifest-viewport",
    {
      role: "grid",
      "aria-label": "Channel media manifest",
      "aria-rowcount": "0",
      // Focusable only programmatically: when the focused row scrolls out of
      // the window it is recycled, and focus has to land somewhere that still
      // receives the arrow keys.
      tabindex: "-1",
    },
    [canvas]
  );

  /* Sits under the toolbar while a scan runs. A scan walks *messages*, not
     files, so on a text-heavy chat there can be seconds of nothing; saying so
     out loud is the difference between "slow" and "broken". */
  const scanNote = el<"div">("div.scan-note.mono", {
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });

  const root = el<"div">("div.main");
  root.append(toolbar, scanNote);

  /* ---------- body swapping ---------------------------------------------- */

  /* The toolbar and the scan note are never removed — replaceChildren() would
     detach the toolbar and blur the search box mid-keystroke, and re-creating
     the note would restart its live region on every body swap. Only the region
     below them is swapped, and only when the state key actually changes. */
  let bodyKey = "";

  function setBody(key: string, make: () => HTMLElement[]): void {
    if (key === bodyKey) return;
    bodyKey = key;
    let tailNode = root.lastElementChild;
    while (tailNode && tailNode !== scanNote && tailNode !== toolbar) {
      tailNode.remove();
      tailNode = root.lastElementChild;
    }
    root.append(...make());
  }

  function emptyState(
    glyph: IconName,
    heading: string,
    body: string,
    action?: HTMLElement
  ): HTMLElement {
    return el<"div">("div.empty", {}, [
      el<"span">("span", { html: icon(glyph, 34) }),
      el<"h3">("h3", { text: heading }),
      el<"p">("p.selectable", { text: body }),
      action,
    ]);
  }

  /* ---------- skeletons --------------------------------------------------- */

  function skelBar(width: string): HTMLElement {
    return el<"span">("span.skel-bar", { style: `width:${width}` });
  }

  /**
   * One placeholder row. It carries `.media-row` deliberately: the column grid
   * — and the responsive rules that drop columns from it — then applies to the
   * placeholder and the real row identically, so replacing one with the other
   * moves nothing on screen. `aria-hidden` plus the absence of `tabindex`
   * keeps it out of both the accessibility tree and the tab order; CSS also
   * takes its pointer events away so it can never be hovered or clicked.
   *
   * `--skel-i` only shifts the shimmer's phase, so the row it lands on is
   * irrelevant beyond making neighbours look independent.
   */
  function skelRow(i: number): HTMLElement {
    const w = SKELETON_W[i % SKELETON_W.length] ?? 70;
    return el<"div">(
      "div.media-row.skel-row",
      { "aria-hidden": "true", style: `--skel-i:${i % 6}` },
      [
        // Empty, like `.m-action`: a shimmering bar where a checkbox will be
        // would read as a control that cannot be clicked yet. The cell still
        // has to exist so the columns line up with the real rows.
        el<"span">("span.m-check"),
        el<"span">("span.m-seq", {}, [skelBar("58%")]),
        el<"span">("span.m-kind", {}, [skelBar("100%")]),
        el<"span">("span.m-name", {}, [skelBar(`${w}%`)]),
        el<"span">("span.m-size", {}, [skelBar("64%")]),
        el<"span">("span.m-date", {}, [skelBar("78%")]),
        el<"span">("span.m-status", {}, [skelBar("52%")]),
        el<"span">("span.m-action"),
      ]
    );
  }

  /** The first-page placeholder. Rendered under the real `.manifest-head` so
   *  the header does not appear late and shove the list down. */
  function skelList(): HTMLElement {
    const list = el<"div">("div.skel-list", { "aria-hidden": "true" });
    for (let i = 0; i < SKELETON_ROWS; i++) list.append(skelRow(i));
    return list;
  }

  /** Built once and moved in and out of the canvas. These are chrome, not
   *  data, so they never enter the row pool. */
  let tail: HTMLElement[] | null = null;

  /**
   * Sizes the canvas and parks the tail placeholders after the last real row.
   *
   * The canvas is the only thing giving the viewport a scroll range, so its
   * height has to include the placeholders: rows hanging past
   * `view.length * ROW_H` would be unreachable, and the scrollbar would jump
   * the moment they were swapped for real rows. render() is untouched by this
   * — it still only ever mounts pooled rows for indices in [0, view.length),
   * and the tail nodes live outside `mounted` so recycling never sees them.
   */
  function syncTail(): void {
    const show = loading && view.length > 0 && !stalled;
    if (show && !tail) {
      tail = Array.from({ length: TAIL_SKELETONS }, (_, i) => skelRow(i));
    }
    const rows = tail ?? [];
    canvas.style.height = `${(view.length + (show ? rows.length : 0)) * ROW_H}px`;
    for (const [i, node] of rows.entries()) {
      if (!show) {
        node.remove();
        continue;
      }
      node.style.top = `${(view.length + i) * ROW_H}px`;
      if (node.parentNode !== canvas) canvas.append(node);
    }
  }

  /**
   * How much history the scan has covered. Telegram message ids increment by
   * one per message within a chat, so the distance the cursor has travelled
   * approximates the number of messages walked. Deleted messages leave gaps
   * and the first page's span is unknown (the cursor starts at 0), so this is
   * always presented as "about".
   */
  function scannedLabel(): string | null {
    if (scanFrom === null || nextOffset === null || nextOffset >= scanFrom) return null;
    return `about ${(scanFrom - nextOffset).toLocaleString()} messages`;
  }

  function syncScanNote(): void {
    if (!loading || !channel) {
      scanNote.hidden = true;
      scanNote.textContent = "";
      return;
    }
    const scanned = scannedLabel();
    const detail = items.length
      ? `${items.length} file${items.length === 1 ? "" : "s"} so far`
      : scanned
        ? `${scanned} checked`
        : "";
    const text = detail
      ? `Scanning history for media — ${detail}`
      : "Scanning history for media…";
    if (scanNote.textContent !== text) scanNote.textContent = text;
    scanNote.hidden = false;
  }

  /** Everything that has to move when `loading` flips. */
  function syncLoading(): void {
    if (loading) viewport.setAttribute("aria-busy", "true");
    else viewport.removeAttribute("aria-busy");
    syncScanNote();
    syncTail();
  }

  function syncBody(): void {
    if (!channel) {
      setBody("none", () => [
        emptyState(
          "inbox",
          "No channel selected",
          "Pick a channel from the rail to read its manifest, or resolve one by @username."
        ),
      ]);
      return;
    }
    if (loadError && items.length === 0) {
      setBody(`err:${loadError}`, () => {
        const retry = el<"button">("button.btn", { type: "button" }, [
          el<"span">("span", { html: icon("refresh", 15) }),
          el<"span">("span", { text: "Try again" }),
        ]);
        retry.addEventListener("click", () => {
          loadError = null;
          syncBody();
          void loadPage();
        });
        return [
          emptyState("alert", "Could not load this channel", loadError ?? "", retry),
        ];
      });
      return;
    }
    if (loading && items.length === 0) {
      // Placeholder rows, not a spinner: the first page can take seconds, and
      // a shaped list tells the user what is coming and how it will be laid
      // out. The real head goes above them so it does not arrive late and
      // push the whole list down.
      setBody("loading", () => [head, skelList()]);
      return;
    }
    if (stalled && items.length === 0) {
      // Not "no media" — we ran out of patience, not out of history. Say what
      // was actually covered and let the user ask for more.
      const scanned = scannedLabel();
      setBody(`stall:${nextOffset}`, () => {
        const keep = el<"button">("button.btn", { type: "button" }, [
          el<"span">("span", { html: icon("refresh", 15) }),
          el<"span">("span", { text: "Keep looking" }),
        ]);
        keep.addEventListener("click", () => {
          // The cap guards against an unbounded background loop; it is not a
          // verdict, so an explicit ask clears it.
          emptyPages = 0;
          stalled = false;
          void loadPage();
        });
        return [
          emptyState(
            "search",
            "No media in recent history",
            scanned
              ? `Checked ${scanned} without finding a file. This chat has more history further back.`
              : "Nothing in the messages checked so far, but this chat has more history further back.",
            keep
          ),
        ];
      });
      return;
    }
    if (items.length === 0) {
      setBody("nomedia", () => [
        emptyState(
          "inbox",
          "No media here",
          filter === "all"
            ? "This channel has no downloadable files in its history."
            : "No files of this type. Try the All tab.",
        ),
      ]);
      return;
    }
    if (view.length === 0) {
      setBody("nomatch", () => [
        emptyState(
          "search",
          "No matching files",
          "Nothing in the loaded pages matches that name. Clear the filter or scroll further back in history first.",
        ),
      ]);
      return;
    }
    setBody("list", () => [head, viewport]);
  }

  /* ---------- rows ------------------------------------------------------- */

  function makeRow(): Row {
    // `tabindex="-1"` on purpose: a tab stop per row would mean thousands of
    // stops in a manifest, so the box is driven by Space on the focused row
    // (see onKeyDown) and by clicking the cell. `data-check` marks the whole
    // cell — not just the 15px box — as the hit target, which is what makes it
    // comfortable to click; the accessible name is filled in by paint().
    const check = el<"input">("input.cbx", { type: "checkbox", tabindex: "-1" });
    const checkCell = el<"span">("span.m-check", { role: "gridcell", "data-check": "" }, [
      check,
    ]);
    const seq = el<"span">("span.m-seq", { role: "gridcell" });
    const kind = el<"span">("span.m-kind", { role: "gridcell" });
    const name = el<"span">("span.m-name", { role: "gridcell" });
    const size = el<"span">("span.m-size", { role: "gridcell" });
    const when = el<"span">("span.m-date", { role: "gridcell" });
    const status = el<"span">("span.m-status", { role: "gridcell" });
    const dl = el<"button">("button.btn-icon", {
      type: "button",
      "data-dl": "",
      html: icon("download", 15),
    });
    const action = el<"span">("span.m-action", { role: "gridcell" }, [dl]);
    const node = el<"div">(
      "div.media-row",
      { role: "row", tabindex: "0", "data-selected": "false", "aria-selected": "false" },
      [checkCell, seq, kind, name, size, when, status, action]
    );
    return {
      node,
      check,
      seq,
      kind,
      name,
      size,
      when,
      status,
      action,
      vIndex: -1,
      vId: -1,
      vKind: "",
      vName: "",
      vSize: -1,
      vDate: -1,
      vStatus: "\u0000",
      vSelected: false,
    };
  }

  function acquire(): Row {
    return pool.pop() ?? makeRow();
  }

  function release(r: Row): void {
    // Recycling the node that owns focus would drop the keyboard user on
    // <body>; park focus on the grid so arrow keys keep working.
    if (r.node.contains(document.activeElement)) viewport.focus();
    r.node.remove();
    if (pool.length < 64) pool.push(r);
  }

  function stateOf(item: MediaItem): string {
    if (!channel) return "";
    return jobStates.get(`${channel.id}:${item.message_id}`) ?? "";
  }

  function paint(r: Row, item: MediaItem, index: number): void {
    if (r.vIndex !== index) {
      r.vIndex = index;
      r.node.style.top = `${index * ROW_H}px`;
      r.node.dataset.i = String(index);
      r.node.setAttribute("aria-rowindex", String(index + 1));
    }
    if (r.vId !== item.message_id) {
      r.vId = item.message_id;
      r.node.dataset.id = String(item.message_id);
    }
    if (r.vKind !== item.kind) {
      r.vKind = item.kind;
      r.node.dataset.kind = item.kind;
      r.kind.innerHTML = kindIcon(item.kind, 14); // ours, not Telegram's
    }
    if (r.seq.textContent !== String(item.seq)) r.seq.textContent = String(item.seq);
    if (r.vName !== item.name) {
      r.vName = item.name;
      r.name.textContent = ellipsize(item.name, NAME_MAX);
      r.name.title = item.name;
      const dl = r.action.firstElementChild;
      if (dl) {
        dl.setAttribute("aria-label", `Download ${item.name}`);
        dl.setAttribute("title", `Download ${item.name}`);
      }
      // The box has no visible label of its own, so it borrows the filename.
      // setAttribute, never innerHTML — this string is Telegram's.
      r.check.setAttribute("aria-label", `Select ${item.name}`);
    }
    if (r.vSize !== item.size) {
      r.vSize = item.size;
      r.size.textContent = bytes(item.size);
    }
    if (r.vDate !== item.date) {
      r.vDate = item.date;
      r.when.textContent = date(item.date);
    }
    const st = stateOf(item);
    if (r.vStatus !== st) {
      r.vStatus = st;
      r.status.textContent = st;
      if (st) r.status.dataset.s = st;
      else delete r.status.dataset.s;
    }
    const sel = selected.has(item.message_id);
    if (r.vSelected !== sel) {
      r.vSelected = sel;
      r.node.dataset.selected = String(sel);
      r.node.setAttribute("aria-selected", String(sel));
      // paint() is the *only* writer of `.checked`, which is what keeps a
      // recycled row from carrying a stale tick: `vSelected` and the DOM are
      // written together or not at all. That invariant is also why the click
      // handler cancels the browser's own toggle — see onClick.
      r.check.checked = sel;
    }
  }

  /** Mount exactly the window [first, last) and recycle everything else. */
  function render(): void {
    if (dead) return;
    const top = viewport.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(view.length, Math.ceil((top + viewportH) / ROW_H) + OVERSCAN);

    for (const [i, r] of mounted) {
      if (i < first || i >= last) {
        mounted.delete(i);
        release(r);
      }
    }
    for (let i = first; i < last; i++) {
      const item = view[i];
      if (!item) continue;
      let r = mounted.get(i);
      if (!r) {
        r = acquire();
        mounted.set(i, r);
        canvas.append(r.node);
      }
      paint(r, item, i);
    }
  }

  const scheduleRender = rafBatch(render);

  /** Drop every mounted row: a change to `view` invalidates index -> item. */
  function unmountAll(): void {
    for (const [i, r] of mounted) {
      mounted.delete(i);
      release(r);
    }
  }

  function recompute(): void {
    const q = query.trim().toLowerCase();
    view = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
    syncTail(); // owns the canvas height: it has to cover the tail skeletons too
    viewport.setAttribute("aria-rowcount", String(view.length));
    if (focusIdx >= view.length) focusIdx = -1;
    unmountAll();
    // The select-all box describes `view`, so a change to `view` changes it
    // even though nothing was selected or deselected — typing in the search
    // box can turn "some" into "all" without the user touching a row.
    syncChrome();
    syncBody();
    render();
  }

  /* ---------- toolbar chrome --------------------------------------------- */

  /** How many rows of the current `view` are selected. Linear, but only ever
   *  walked when something is selected at all — which keeps it off the paging
   *  path, where this would otherwise run once per arriving page. */
  function selectedInView(): number {
    if (selected.size === 0) return 0;
    let n = 0;
    for (const it of view) if (selected.has(it.message_id)) n++;
    return n;
  }

  function syncChrome(): void {
    titleEl.textContent = channel ? channel.title : "No channel selected";

    const parts: string[] = [];
    if (channel?.username) parts.push(`@${channel.username}`);
    if (channel?.participants != null) {
      parts.push(`${channel.participants.toLocaleString()} members`);
    }
    if (channel) {
      const known = total ?? counts.get(filter) ?? null;
      parts.push(known != null ? `${known} files` : `${items.length}+ files`);
    }
    subEl.textContent = parts.join(" · ");

    for (const f of FILTERS) {
      const pill = pills.get(f.id);
      const tab = tabs.get(f.id);
      if (!pill || !tab) continue;
      // While the "All" tab is loaded, every per-type count is already
      // derivable from the items in hand — each one carries its `kind`. Doing
      // that here means the type tabs show a real number straight away instead
      // of a dash that only resolves once the user clicks and triggers a fresh
      // scan. Still a floor while paging, hence the "+".
      const derived =
        filter === "all" && f.id !== "all" && items.length
          ? items.reduce((n, it) => n + (it.kind === f.id ? 1 : 0), 0)
          : null;

      const known = counts.get(f.id);
      const loadedAll = filter === "all" && nextOffset === null;
      // "1234+" while paging: the loaded count is a floor, not the total.
      const text =
        known != null
          ? String(known)
          : derived != null
            ? loadedAll
              ? String(derived)
              : `${derived}+`
            : f.id === filter && items.length
              ? `${items.length}+`
              : "—";
      if (pill.textContent !== text) pill.textContent = text;
      pill.dataset.active = String(f.id === filter);
      tab.setAttribute("aria-selected", String(f.id === filter));
    }

    dlBtn.hidden = selected.size === 0;
    dlLabel.textContent = `Download ${selected.size}`;

    /* Tri-state select-all. It is derived from `view`, not `items`, and not
       from `selected` — `selected` can hold ids the search box is currently
       hiding, and `items` can only ever be a prefix of a channel that is still
       paging. The box therefore promises exactly what its click delivers: the
       rows on screen right now. The name says "loaded" for the same reason —
       "select all" over an unbounded history would be a lie. */
    const inView = selectedInView();
    const all = view.length > 0 && inView === view.length;
    selectAll.checked = all;
    // Property, not attribute: `indeterminate` has no HTML attribute at all.
    selectAll.indeterminate = inView > 0 && !all;
    const scope = query.trim() ? "matching loaded" : "loaded";
    const plural = view.length === 1 ? "" : "s";
    selectAll.setAttribute("aria-label", `Select all ${view.length} ${scope} file${plural}`);
    selectAll.title = `Selects the ${view.length} ${scope} file${plural} in this list. Files further back in this channel's history have not been loaded yet.`;
  }

  /* ---------- paging ----------------------------------------------------- */

  async function loadPage(): Promise<void> {
    const ch = channel;
    // `nextOffset === null` is end of history: never ask again.
    if (!ch || dead || loading || nextOffset === null) return;
    const mine = token;
    const firstPage = items.length === 0;
    loading = true;
    if (firstPage) syncBody();
    syncLoading();

    let more = false;
    try {
      const page = await listMedia(ch.id, nextOffset, PAGE_SIZE, filter);
      if (dead || mine !== token) return;
      items = items.concat(page.items);
      scanFrom ??= page.next_offset_id;
      nextOffset = page.next_offset_id;
      // A page can hold zero media and still be progress: the backend walks
      // messages, and a chat can have hundreds of text messages between files.
      // Treating that as "no media here" is the bug this counter fixes — the
      // pager keeps going instead, and only gives up after MAX_EMPTY_PAGES so
      // a genuinely media-free archive cannot spin forever.
      if (page.items.length > 0) emptyPages = 0;
      else if (nextOffset !== null) emptyPages++;
      stalled = emptyPages >= MAX_EMPTY_PAGES;
      if (page.total != null) {
        total = page.total;
        counts.set(filter, page.total);
      } else if (nextOffset === null) {
        // We walked the whole history, so the loaded count *is* the total.
        total = items.length;
        counts.set(filter, items.length);
      }
      loadError = null;
      syncChrome();
      recompute();
      // A short first page leaves no scrollbar, and the scroll-driven pager
      // would then never fire. Keep pulling until the viewport can scroll —
      // which is also what carries the empty-page walk, since a page with no
      // media leaves `items.length` where it was.
      more = nextOffset !== null && !stalled && items.length * ROW_H < viewportH + NEAR_BOTTOM;
    } catch (e) {
      if (dead || mine !== token) return;
      loadError = msgOf(e);
      if (firstPage) syncBody();
      else toast(`Could not load more files: ${loadError}`, "error");
    } finally {
      if (mine === token) loading = false;
    }
    if (dead || mine !== token) return;
    // The body has to be re-derived once `loading` is false, or a chat that
    // ends its walk with nothing to show would sit on the skeleton for good.
    // setBody() no-ops when the key is unchanged, so this is free otherwise.
    syncBody();
    // After `loading` has settled, so the note and the tail skeletons clear.
    // `more` re-enters loadPage() in this same task, before any paint, so the
    // tail does not visibly blink between pages.
    syncLoading();

    if (more) void loadPage();
  }

  function maybePage(): void {
    // `stalled` blocks the scroll-driven pager too: with an empty list the
    // viewport is unmounted, its observed height collapses to 0, and every
    // resize would otherwise read as "near the bottom" and restart the walk.
    if (!channel || dead || loading || stalled || nextOffset === null) return;
    // Derived from the row count instead of scrollHeight so the scroll handler
    // never forces a layout.
    const remaining = view.length * ROW_H - (viewport.scrollTop + viewportH);
    if (remaining < NEAR_BOTTOM) void loadPage();
  }

  /* ---------- selection & keyboard --------------------------------------- */

  function enqueue(ids: number[]): void {
    if (!channel || ids.length === 0) return;
    opts.onEnqueue(channel.id, ids);
  }

  function selectOnly(index: number): void {
    const item = view[index];
    if (!item) return;
    selected.clear();
    selected.add(item.message_id);
    anchor = index;
  }

  function selectRange(from: number, to: number): void {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    selected.clear();
    for (let i = lo; i <= hi; i++) {
      const item = view[i];
      if (item) selected.add(item.message_id);
    }
  }

  /**
   * Checkbox-style toggle: additive, never replacing. This is the difference
   * between the box and the row body — clicking a row means "I want this one",
   * clicking a box means "…and this one too", so it must not clear anything.
   *
   * With `extend`, every row between the anchor and `index` is driven to the
   * state the clicked row is about to take, which is what shift-clicking a
   * checkbox does in a file manager: shift-checking fills the range in,
   * shift-unchecking empties it, and neither disturbs rows outside it.
   */
  function toggleAt(index: number, extend: boolean): void {
    const item = view[index];
    if (!item) return;
    const on = !selected.has(item.message_id);
    const lo = extend && anchor >= 0 ? Math.min(anchor, index) : index;
    const hi = extend && anchor >= 0 ? Math.max(anchor, index) : index;
    for (let i = lo; i <= hi; i++) {
      const it = view[i];
      if (!it) continue;
      if (on) selected.add(it.message_id);
      else selected.delete(it.message_id);
    }
    anchor = index;
    focusIdx = index;
  }

  function focusRow(index: number): void {
    if (index < 0 || index >= view.length) return;
    focusIdx = index;
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewportH) {
      viewport.scrollTop = bottom - viewportH;
    }
    render(); // synchronous: the node must exist before we can focus it
    mounted.get(index)?.node.focus();
  }

  function rowIndexFrom(target: EventTarget | null): number {
    const node = target instanceof Element ? target.closest(".media-row") : null;
    if (!(node instanceof HTMLElement)) return -1;
    const i = Number(node.dataset.i);
    return Number.isInteger(i) ? i : -1;
  }

  const onClick = (e: MouseEvent): void => {
    const index = rowIndexFrom(e.target);
    if (index < 0) return;
    const item = view[index];
    if (!item) return;

    // The per-row download button is the single-file shortcut and must not
    // disturb the current selection.
    if (e.target instanceof Element && e.target.closest("[data-dl]")) {
      e.stopPropagation();
      enqueue([item.message_id]);
      return;
    }

    // The checkbox cell. This handler is delegated, so the row's own
    // select/ctrl/shift logic below is skipped by returning early rather than
    // by stopping propagation; stopPropagation is still called so the click
    // does not escape the grid to any ancestor listener.
    if (e.target instanceof Element && e.target.closest("[data-check]")) {
      e.stopPropagation();
      // Cancels the browser's own toggle so paint() stays the single writer of
      // `.checked`. Without this a shift-click that leaves a row selected would
      // desync forever: the box would have flipped itself off, while paint()
      // compares against `vSelected`, sees no change, and never writes it back.
      e.preventDefault();
      toggleAt(index, e.shiftKey);
      syncChrome();
      render();
      return;
    }

    focusIdx = index;
    if (e.shiftKey && anchor >= 0) selectRange(anchor, index);
    else if (e.ctrlKey || e.metaKey) {
      if (selected.has(item.message_id)) selected.delete(item.message_id);
      else selected.add(item.message_id);
      anchor = index;
    } else selectOnly(index);

    syncChrome();
    render();
  };

  const onFocusIn = (e: FocusEvent): void => {
    const index = rowIndexFrom(e.target);
    if (index >= 0) focusIdx = index;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!view.length) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      selected.clear();
      for (const it of view) selected.add(it.message_id);
      anchor = 0;
      syncChrome();
      render();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        focusIdx < 0
          ? step > 0
            ? 0
            : view.length - 1
          : Math.min(view.length - 1, Math.max(0, focusIdx + step));
      focusRow(next);
      return;
    }
    // Space toggles, Enter downloads — the split the checkbox makes necessary,
    // and the one a file manager already trains. preventDefault does double
    // duty: Space would otherwise page the viewport, and when focus is sitting
    // on a row's checkbox (a click puts it there) it would also let the box
    // toggle itself, which is the one path that could get ahead of `selected`.
    if (e.key === " ") {
      if (focusIdx < 0) return;
      e.preventDefault();
      toggleAt(focusIdx, e.shiftKey);
      syncChrome();
      render();
      return;
    }
    if (e.key === "Enter") {
      if (focusIdx < 0) return;
      const item = view[focusIdx];
      if (!item) return;
      e.preventDefault();
      enqueue([item.message_id]);
    }
  };

  const onScroll = (): void => {
    // A scroll event can only happen when there are rows to scroll, and
    // reaching for more is a deliberate "keep looking" — so it lifts the cap
    // the background walk stopped at. Without this, a list whose remaining
    // history is all text would be a silent dead end.
    if (stalled && view.length > 0) {
      stalled = false;
      emptyPages = 0;
    }
    scheduleRender();
    maybePage();
  };

  const onSearch = debounce((): void => {
    if (dead) return;
    query = searchInput.value;
    viewport.scrollTop = 0;
    focusIdx = -1;
    recompute();
  }, 200);

  const onTabs = (e: MouseEvent): void => {
    const btn = e.target instanceof Element ? e.target.closest("[data-f]") : null;
    if (!(btn instanceof HTMLElement)) return;
    const next = btn.dataset.f as MediaFilter | undefined;
    if (!next || next === filter) return;
    filter = next;
    reset();
  };

  const onDownload = (): void => {
    enqueue([...selected]);
  };

  /* Acts on `view` — the loaded, filtered rows the box reports on — and never
     on `items` or on history that has not been paged in. Clearing likewise
     only drops what is on screen, so a selection made before a search phrase
     was typed survives clearing the filtered rows. syncChrome() re-derives the
     box afterwards, so the browser's own toggle needs no cancelling here. */
  const onSelectAll = (): void => {
    const on = selectedInView() < view.length;
    for (const it of view) {
      if (on) selected.add(it.message_id);
      else selected.delete(it.message_id);
    }
    anchor = view.length > 0 ? 0 : -1;
    syncChrome();
    render();
  };

  const ro = new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height ?? 0;
    if (h === viewportH) return;
    viewportH = h;
    render();
    maybePage();
  });

  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("keydown", onKeyDown);
  viewport.addEventListener("focusin", onFocusIn);
  canvas.addEventListener("click", onClick);
  searchInput.addEventListener("input", onSearch);
  tabsEl.addEventListener("click", onTabs);
  dlBtn.addEventListener("click", onDownload);
  // `change`, not `click`: it covers Space on the focused box too, and it is
  // not fired by the programmatic writes in syncChrome().
  selectAll.addEventListener("change", onSelectAll);
  ro.observe(viewport);

  /* ---------- lifecycle -------------------------------------------------- */

  /** Discards paging state and starts over for the current channel + filter. */
  function reset(): void {
    token++; // orphan any in-flight page
    loading = false;
    items = [];
    view = items;
    nextOffset = 0;
    total = null;
    loadError = null;
    emptyPages = 0;
    stalled = false;
    scanFrom = null;
    selected.clear();
    anchor = -1;
    focusIdx = -1;
    viewport.scrollTop = 0;
    unmountAll();
    syncLoading(); // drops the tail skeletons and zeroes the canvas height
    syncChrome();
    // loadPage() switches the body to the loading state synchronously, so
    // asking for it first avoids a frame of "no media here".
    if (channel) void loadPage();
    else syncBody();
  }

  syncChrome();
  syncBody();

  return {
    el: root,

    setChannel(ch: ChannelInfo | null): void {
      channel = ch;
      counts.clear();
      // A search phrase from the previous channel would silently hide the new
      // channel's first page.
      query = "";
      searchInput.value = "";
      filter = "all";
      reset();
    },

    setJobStates(map: Map<string, JobState>): void {
      jobStates = map;
      render(); // paint() only rewrites the status cells that actually moved
    },

    destroy(): void {
      dead = true;
      token++;
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("focusin", onFocusIn);
      canvas.removeEventListener("click", onClick);
      searchInput.removeEventListener("input", onSearch);
      tabsEl.removeEventListener("click", onTabs);
      dlBtn.removeEventListener("click", onDownload);
      selectAll.removeEventListener("change", onSelectAll);
      ro.disconnect();
      unmountAll();
      pool.length = 0;
    },
  };
}
