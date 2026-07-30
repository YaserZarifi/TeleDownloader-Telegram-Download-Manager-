/** Presentation helpers. All of these are called inside render loops, so they
 *  must stay allocation-light and never throw on bad input. */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1.4 GB — binary units, at most one decimal, tabular-friendly width. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const dp = u === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(dp)} ${UNITS[u]}`;
}

/** 8.2 MB/s */
export function speed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s";
  return `${bytes(bps)}/s`;
}

/** 1h 04m / 4m 12s / 38s */
export function duration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/** 12 Mar 2024 — locale-aware, fixed width enough for a mono column. */
export function date(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "—";
  return DATE_FMT.format(new Date(unixSeconds * 1000));
}

export function percent(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(1, done / total));
}

/** Middle-ellipsis: keeps the extension visible, which matters in a file list. */
export function ellipsize(name: string, max = 64): string {
  if (name.length <= max) return name;
  const keepEnd = Math.min(14, Math.floor(max / 3));
  return `${name.slice(0, max - keepEnd - 1)}…${name.slice(-keepEnd)}`;
}
