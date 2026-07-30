/** Tiny DOM helpers. Deliberately not a framework — this app renders a few
 *  hundred nodes and a virtualized list; a VDOM would cost more than it saves
 *  and would add startup weight a native app shouldn't carry. */

import { icon } from "./icons";

type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * el("div#id.class.class", attrs?, children?)
 *
 * The spec is split on "." FIRST, then the id is taken from the tag segment —
 * so an id must be written before any class ("div#id.cls"), never after one
 * ("div.cls#id" would yield a class literally named "cls#id"). Attributes go
 * in the second argument.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: string,
  attrs?: Attrs,
  children?: Array<Node | string | null | undefined> | string
): HTMLElementTagNameMap[K] {
  // Tolerate an id in any segment ("div.cls#id" as well as "div#id.cls").
  // The strict split-on-dot-first parse once produced an element whose single
  // class was literally "main#main-region" — no styles matched and the layout
  // silently collapsed, which took a headless-browser session to find.
  const segments = spec.split(".");
  let [tag, id] = segments[0].split("#");
  const classes: string[] = [];
  for (const seg of segments.slice(1)) {
    const [cls, segId] = seg.split("#");
    if (cls) classes.push(cls);
    if (segId) id = segId;
  }
  const node = document.createElement(tag || "div");
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(" ");

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "html") node.innerHTML = String(v);
      else if (k === "text") node.textContent = String(v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }

  if (typeof children === "string") {
    node.textContent = children;
  } else if (children) {
    for (const c of children) {
      if (c == null) continue;
      node.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node as HTMLElementTagNameMap[K];
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** Query that throws instead of returning null — a missing node is a bug, and
 *  failing loudly at startup beats a silent no-op later. */
export function must<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const n = root.querySelector<T>(sel);
  if (!n) throw new Error(`TeleWire: expected element "${sel}" to exist`);
  return n;
}

/* ---------- toasts ------------------------------------------------------- */

let toastHost: HTMLElement | null = null;

export function toast(
  message: string,
  kind: "ok" | "error" | "info" = "info",
  ms = kind === "error" ? 8000 : 4000
): void {
  if (!toastHost) {
    toastHost = el("div.toasts", { role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const glyph = kind === "error" ? "alert" : kind === "ok" ? "check" : "info";
  const node = el("div.toast", { "data-kind": kind }, [
    el("span", { html: icon(glyph, 15) }),
    el("span.selectable", {}, message),
  ]);
  toastHost.append(node);
  setTimeout(() => node.remove(), ms);
}

/* ---------- modal -------------------------------------------------------- */

/**
 * Opens a modal and traps focus in it. Returns a close function.
 * Escape and scrim-click both close, and focus returns to whatever was
 * focused before — otherwise keyboard users get dumped at the top of the page.
 */
export function modal(
  content: HTMLElement,
  opts: { onClose?: () => void; labelledBy?: string } = {}
): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const scrim = el("div.scrim");
  content.classList.add("panel", "modal");
  content.setAttribute("role", "dialog");
  content.setAttribute("aria-modal", "true");
  if (opts.labelledBy) content.setAttribute("aria-labelledby", opts.labelledBy);
  scrim.append(content);

  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    previous?.focus?.();
    opts.onClose?.();
  };

  const focusables = () =>
    Array.from(
      content.querySelectorAll<HTMLElement>(
        'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'
      )
    ).filter((n) => n.offsetParent !== null);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(scrim);
  focusables()[0]?.focus();
  return close;
}

/* ---------- misc --------------------------------------------------------- */

export const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Coalesce bursty work into one call per animation frame. */
export function rafBatch(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): (...args: A) => void {
  let t: number | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms) as unknown as number;
  };
}
