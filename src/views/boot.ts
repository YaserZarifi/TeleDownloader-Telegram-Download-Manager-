/**
 * Startup chrome: the boot skeleton and the welcome banner.
 *
 * Between launch and a usable window the app has to check the keychain, open
 * the session store, reach Telegram, and pull the chat list — several seconds
 * on a cold start. Painting the real frame *shape* immediately, rather than a
 * blank window or a spinner, means the interface never appears to be missing.
 * The skeleton is a structural promise: every block sits where the real
 * element will, so nothing jumps when the content arrives.
 *
 * Lives in its own module (with its own stylesheet) because `styles.css` and
 * `browser.ts` are large, frequently edited files and this is self-contained.
 */

import "./boot.css";
import { icon } from "../lib/icons";
import { el, reducedMotion } from "../lib/ui";

/** One shimmering placeholder block. */
function bar(width: string, height = "10px"): HTMLElement {
  return el("span.boot-bar", { style: `width:${width};height:${height}` });
}

/**
 * The full application frame, drawn as placeholders. Deliberately mirrors the
 * real grid in `styles.css` (`--header-h`, `--wire-h`, `--rail-w`) so the
 * transition to the live shell is a content swap, not a relayout.
 */
export function bootSkeleton(): HTMLElement {
  const railRows = Array.from({ length: 9 }, (_, i) =>
    el("div.boot-chan", {}, [
      el("span.boot-avatar"),
      el("span.boot-lines", {}, [
        bar(`${58 + ((i * 13) % 34)}%`),
        bar(`${30 + ((i * 7) % 25)}%`, "8px"),
      ]),
    ])
  );

  const fileRows = Array.from({ length: 11 }, (_, i) =>
    el("div.boot-row", {}, [
      bar("26px", "12px"),
      el("span.boot-plate"),
      bar(`${44 + ((i * 17) % 46)}%`),
      bar("52px", "9px"),
    ])
  );

  return el("div.boot", { "aria-busy": "true", "aria-label": "Starting TeleWire" }, [
    el("div.boot-masthead", {}, [
      el("span.boot-brand", {}, [
        el("span", { html: icon("wire", 20) }),
        el("b", {}, "TELE"),
        el("span.boot-brand-dim", {}, "WIRE"),
      ]),
      el("span.boot-spacer"),
      bar("92px", "22px"),
    ]),
    el("div.boot-wire"),
    el("div.boot-body", {}, [
      el("div.boot-rail", {}, [bar("64%", "9px"), ...railRows]),
      el("div.boot-main", {}, [
        el("div.boot-toolbar", {}, [bar("180px", "16px"), el("span.boot-spacer"), bar("220px", "26px")]),
        ...fileRows,
      ]),
    ]),
  ]);
}

/**
 * A brief, self-dismissing greeting once the shell is live.
 *
 * Shown only on a genuine sign-in transition, never on every render — a banner
 * that reappears constantly is noise, and this one exists to confirm *which*
 * account is connected, which matters for an app that logs into a real one.
 */
export function welcomeBanner(name: string, onDone?: () => void): HTMLElement {
  const node = el("div.welcome", { role: "status" }, [
    el("span.welcome-mark", { html: icon("wire", 18) }),
    el("span", {}, [
      el("div.welcome-title", {}, `Linked as ${name}`),
      el("div.welcome-sub", {}, "Direct to Telegram. Nothing in between."),
    ]),
  ]);

  // Reduced motion still gets the message, just without the slide.
  const life = reducedMotion() ? 2600 : 3400;
  setTimeout(() => {
    node.dataset.leaving = "true";
    setTimeout(
      () => {
        node.remove();
        onDone?.();
      },
      reducedMotion() ? 0 : 260
    );
  }, life);

  return node;
}
