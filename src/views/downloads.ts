/**
 * Downloads view — the transfer queue.
 *
 * Two paths run through here and they have very different budgets:
 *
 *   render(jobs)        cold. Reconciles the job list against a Map keyed by
 *                       id — create / update / remove — because rebuilding the
 *                       list would reset the scroll position and blow away
 *                       whatever button the user had focused.
 *   applyProgress(b)    hot, every ~400ms while anything moves. It may only
 *                       write `style.width` and `textContent` on nodes that
 *                       already exist. No node creation, no attribute churn,
 *                       and no layout reads inside the loop.
 *
 * Filenames and backend error strings are attacker-influenced, so they only
 * ever go in through `textContent`; `html:` carries our own icon SVG.
 */

import type { Job, JobState, MediaKind, ProgressBatch } from "../lib/types";
import { bytes, duration, percent, speed } from "../lib/format";
import { icon, kindIcon, type IconName } from "../lib/icons";
import { el, reducedMotion } from "../lib/ui";

/** Matches the `land` keyframe window in the stylesheet, with a little slack. */
const JUST_DONE_MS = 700;

export interface DownloadsView {
  el: HTMLElement;
  render(jobs: Job[]): void;
  applyProgress(batch: ProgressBatch): void;
  destroy(): void;
}

/** A live `.job` plus the values last written into it. Comparing before
 *  writing keeps the 400ms tick down to the cells that actually moved. */
interface JobRow {
  node: HTMLElement;
  iconEl: HTMLElement;
  nameEl: HTMLElement;
  fill: HTMLElement;
  sizes: HTMLElement;
  spd: HTMLElement;
  eta: HTMLElement;
  conns: HTMLElement;
  workersEl: HTMLElement;
  workerFills: HTMLElement[];
  errEl: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  /** Authoritative size; progress batches carry `done` but not `size`. */
  size: number;
  state: JobState | null;
  kind: MediaKind | null;
  name: string;
  errText: string;
  vFill: string;
  vSizes: string;
  vSpd: string;
  vEta: string;
  vConns: string;
  /** "connecting" while a running job has yet to receive its first byte. */
  vPhase: string;
  vWorkers: string[];
}

/** `Job` has no `kind`, so the icon is inferred from the extension. Wrong
 *  guesses cost nothing but a glyph. */
const VIDEO = /\.(mp4|mkv|mov|avi|webm|m4v|mpe?g|ts|wmv|flv)$/i;
const AUDIO = /\.(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/i;
const PHOTO = /\.(jpe?g|png|gif|webp|bmp|heic|heif|tiff?|avif)$/i;

function kindOf(name: string): MediaKind {
  if (VIDEO.test(name)) return "video";
  if (AUDIO.test(name)) return "audio";
  if (PHOTO.test(name)) return "photo";
  return "document";
}

/** done / cancelled / error are what `clear_finished` reaps on the Rust side. */
const isFinished = (s: JobState): boolean =>
  s === "done" || s === "cancelled" || s === "error";

export function createDownloads(opts: {
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onReveal: (path: string) => void;
  onClearFinished: () => void;
}): DownloadsView {
  const rows = new Map<string, JobRow>();
  const doneTimers = new Map<string, number>();
  let dead = false;

  /* Aggregate. render() owns it while nothing is moving; applyProgress()
     overwrites it on every tick, which is the only source accurate to the
     sampling window. */
  let activeCount = 0;
  let totalBps = 0;

  /* ---------- chrome ----------------------------------------------------- */

  const aggEl = el<"div">("div.toolbar-sub", { text: "0 active · 0 B/s" });
  const clearBtn = el<"button">("button.btn.btn-ghost", { type: "button" }, [
    el<"span">("span", { html: icon("trash", 15) }),
    el<"span">("span", { text: "Clear finished" }),
  ]);
  clearBtn.disabled = true;

  const toolbar = el<"div">("div.toolbar", {}, [
    el<"div">("div.toolbar-title", {}, [
      el<"div">("div.eyebrow", { text: "Transfer queue" }),
      aggEl,
    ]),
    el<"div">("div.masthead-spacer"),
    clearBtn,
  ]);

  const queue = el<"div">("div.queue", { role: "list", "aria-label": "Downloads" });

  const empty = el<"div">("div.empty", {}, [
    el<"span">("span", { html: icon("inbox", 34) }),
    el<"h3">("h3", { text: "Nothing in the queue" }),
    el<"p">("p", {
      text: "Files you pick from a channel manifest land here and start transferring straight away.",
    }),
  ]);

  const root = el<"div">("div.main");
  root.append(toolbar, empty);
  let showingEmpty = true;

  const onClear = (): void => opts.onClearFinished();
  clearBtn.addEventListener("click", onClear);

  function syncAggregate(): void {
    const text = `${activeCount} active · ${speed(totalBps)}`;
    if (aggEl.textContent !== text) aggEl.textContent = text;
  }

  /* ---------- row construction ------------------------------------------- */

  function iconBtn(
    glyph: IconName,
    label: string,
    danger: boolean,
    onClick: () => void
  ): HTMLElement {
    const b = el<"button">(`button.btn-icon${danger ? ".btn-danger" : ""}`, {
      type: "button",
      // Icon-only controls carry both: aria-label names it, title explains it
      // to a mouse user.
      "aria-label": label,
      title: label,
      html: icon(glyph, 15),
    });
    b.addEventListener("click", onClick);
    return b;
  }

  function makeRow(job: Job): JobRow {
    const iconEl = el<"div">("div.job-icon");
    const nameEl = el<"div">("div.job-name");
    const fill = el<"div">("div.bar-fill");
    const bar = el<"div">("div.bar", { role: "presentation" }, [fill]);
    const sizes = el<"span">("span");
    const spd = el<"b">("b");
    const eta = el<"span">("span");
    const conns = el<"span">("span");
    const stats = el<"div">("div.job-stats", {}, [
      sizes,
      el<"span">("span.sep", { text: "·" }),
      spd,
      el<"span">("span.sep", { text: "·" }),
      eta,
      el<"span">("span.sep", { text: "·" }),
      conns,
    ]);
    const workersEl = el<"div">("div.workers", { "aria-hidden": "true" });
    const errEl = el<"div">("div.job-err.selectable", { role: "alert" });
    const body = el<"div">("div.job-body", {}, [nameEl, bar, stats]);
    const actions = el<"div">("div.job-actions");
    const node = el<"div">("div.job", { role: "listitem", "data-id": job.id }, [
      iconEl,
      body,
      actions,
    ]);

    return {
      node,
      iconEl,
      nameEl,
      fill,
      sizes,
      spd,
      eta,
      conns,
      workersEl,
      workerFills: [],
      errEl,
      body,
      actions,
      size: job.size,
      state: null,
      kind: null,
      name: "",
      errText: "",
      vFill: "",
      vSizes: "",
      vSpd: "",
      vEta: "",
      vConns: "",
      vPhase: "",
      vWorkers: [],
    };
  }

  /** Buttons depend only on state, so this runs on transitions, never on the
   *  progress tick. */
  function buildActions(row: JobRow, job: Job): void {
    const kids: HTMLElement[] = [];
    switch (job.state) {
      case "running":
        kids.push(iconBtn("pause", "Pause download", false, () => opts.onPause(job.id)));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "paused":
        kids.push(iconBtn("play", "Resume download", false, () => opts.onResume(job.id)));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "queued":
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "error":
        kids.push(iconBtn("refresh", "Retry download", false, () => opts.onRetry(job.id)));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "cancelled":
        kids.push(iconBtn("refresh", "Retry download", false, () => opts.onRetry(job.id)));
        break;
      case "done":
        kids.push(
          iconBtn("folder", "Reveal in folder", false, () => opts.onReveal(job.dest_path))
        );
        break;
    }
    row.actions.replaceChildren(...kids);
  }

  /* ---------- shared write path ------------------------------------------ */

  /** The only function allowed to touch progress cells, from either path. */
  function paintProgress(
    row: JobRow,
    done: number,
    bps: number,
    etaS: number | null,
    workers: number,
    workerFill: number[]
  ): void {
    // Opening connections, resolving the file location and (for a file on
    // another data center) copying the authorization all happen before the
    // first byte lands. On a big file that is several seconds of a bar sitting
    // at 0 B/s, which reads as "stuck". Flag the phase so the row can say
    // "Connecting…" and run an indeterminate bar instead of a dead one.
    const phase =
      row.state === "running" && done === 0 && bps === 0 ? "connecting" : "";
    if (row.vPhase !== phase) {
      row.vPhase = phase;
      if (phase) row.node.dataset.phase = phase;
      else delete row.node.dataset.phase;
    }

    const w = `${(percent(done, row.size) * 100).toFixed(2)}%`;
    if (row.vFill !== w) {
      row.vFill = w;
      row.fill.style.width = w;
    }
    const sizes = `${bytes(done)} / ${bytes(row.size)}`;
    if (row.vSizes !== sizes) {
      row.vSizes = sizes;
      row.sizes.textContent = sizes;
    }
    const s = phase === "connecting" ? "Connecting…" : speed(bps);
    if (row.vSpd !== s) {
      row.vSpd = s;
      row.spd.textContent = s;
    }
    const e = `ETA ${duration(etaS)}`;
    if (row.vEta !== e) {
      row.vEta = e;
      row.eta.textContent = e;
    }
    const c = `${workers} ${workers === 1 ? "connection" : "connections"}`;
    if (row.vConns !== c) {
      row.vConns = c;
      row.conns.textContent = c;
    }
    syncWorkers(row, workerFill);
  }

  /** The strip is rebuilt only when the worker COUNT changes — the adaptive
   *  controller moves it rarely, while the fills move every tick. */
  function syncWorkers(row: JobRow, fills: number[]): void {
    if (fills.length !== row.workerFills.length) {
      row.workerFills = fills.map(() => el<"i">("i"));
      row.workersEl.replaceChildren(
        ...row.workerFills.map((f) => el<"div">("div.worker", {}, [f]))
      );
      row.vWorkers = new Array<string>(fills.length).fill("");
      const attached = row.workersEl.parentNode !== null;
      if (fills.length && !attached) row.body.insertBefore(row.workersEl, row.body.children[2] ?? null);
      else if (!fills.length && attached) row.workersEl.remove();
    }
    for (let i = 0; i < fills.length; i++) {
      const raw = fills[i] ?? 0;
      const w = `${(Math.max(0, Math.min(1, raw)) * 100).toFixed(1)}%`;
      if (row.vWorkers[i] === w) continue;
      row.vWorkers[i] = w;
      const node = row.workerFills[i];
      if (node) node.style.width = w;
    }
  }

  function flagJustDone(row: JobRow, id: string): void {
    // The landing pulse is a completion cue, not decoration — suppress it
    // entirely rather than shortening it when motion is reduced.
    if (reducedMotion()) return;
    const prev = doneTimers.get(id);
    if (prev !== undefined) clearTimeout(prev);
    row.node.dataset.justDone = "true";
    doneTimers.set(
      id,
      setTimeout(() => {
        doneTimers.delete(id);
        delete row.node.dataset.justDone;
      }, JUST_DONE_MS) as unknown as number
    );
  }

  function updateRow(row: JobRow, job: Job): void {
    row.size = job.size;

    if (row.state !== job.state) {
      // A job that is already done the first time we see it (app restart,
      // list_jobs replay) has not just landed — don't pulse it.
      const firstSight = row.state === null;
      row.state = job.state;
      row.node.dataset.state = job.state;
      buildActions(row, job);
      if (job.state === "done" && !firstSight) flagJustDone(row, job.id);
    }

    const kind = kindOf(job.name);
    if (row.kind !== kind) {
      row.kind = kind;
      row.iconEl.innerHTML = kindIcon(kind, 16); // ours, never remote content
    }
    if (row.name !== job.name) {
      row.name = job.name;
      row.nameEl.textContent = job.name;
      row.nameEl.title = job.name;
    }

    const err = job.state === "error" ? (job.error ?? "Transfer failed") : "";
    if (row.errText !== err) {
      row.errText = err;
      if (err) {
        row.errEl.textContent = err;
        if (row.errEl.parentNode === null) row.body.append(row.errEl);
      } else row.errEl.remove();
    }

    paintProgress(row, job.done, job.speed_bps, job.eta_s, job.workers, job.worker_fill);
  }

  /* ---------- api -------------------------------------------------------- */

  function showList(list: boolean): void {
    if (showingEmpty === !list) return;
    showingEmpty = !list;
    (list ? empty : queue).remove();
    root.append(list ? queue : empty);
  }

  return {
    el: root,

    render(jobs: Job[]): void {
      if (dead) return;
      const seen = new Set<string>();
      let running = 0;
      let bps = 0;
      let finished = 0;

      // Walk the desired order and slide each node into place. Nodes already
      // in position are not touched, so focus and scroll survive.
      let prev: Node | null = null;
      for (const job of jobs) {
        seen.add(job.id);
        if (job.state === "running") {
          running++;
          bps += job.speed_bps;
        }
        if (isFinished(job.state)) finished++;

        let row = rows.get(job.id);
        if (!row) {
          row = makeRow(job);
          rows.set(job.id, row);
        }
        updateRow(row, job);

        const expected: ChildNode | null = prev ? prev.nextSibling : queue.firstChild;
        if (expected !== row.node) queue.insertBefore(row.node, expected);
        prev = row.node;
      }

      for (const [id, row] of rows) {
        if (seen.has(id)) continue;
        rows.delete(id);
        const t = doneTimers.get(id);
        if (t !== undefined) {
          clearTimeout(t);
          doneTimers.delete(id);
        }
        row.node.remove();
      }

      activeCount = running;
      totalBps = bps;
      syncAggregate();
      clearBtn.disabled = finished === 0;
      showList(jobs.length > 0);
    },

    applyProgress(batch: ProgressBatch): void {
      if (dead) return;
      for (const p of batch.jobs) {
        const row = rows.get(p.id);
        if (!row) continue; // job arrived before its render(); the next one fixes it
        paintProgress(row, p.done, p.speed_bps, p.eta_s, p.workers, p.worker_fill);
      }
      activeCount = batch.jobs.length;
      totalBps = batch.total_bps;
      syncAggregate();
    },

    destroy(): void {
      dead = true;
      clearBtn.removeEventListener("click", onClear);
      for (const t of doneTimers.values()) clearTimeout(t);
      doneTimers.clear();
      // Action listeners live on nodes we drop wholesale, so they go with them.
      queue.replaceChildren();
      rows.clear();
    },
  };
}
