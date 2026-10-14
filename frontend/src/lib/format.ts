export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function formatDate(unix: number) {
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDuration(seconds: number) {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export const pct = (part: number, total: number) => (total ? Math.round((part / total) * 1000) / 10 : 0);

/** `datetime-local` input value <-> unix seconds */
export function toLocalInput(unix: number) {
  const d = new Date(unix * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
export const fromLocalInput = (v: string) => Math.floor(new Date(v).getTime() / 1000);
