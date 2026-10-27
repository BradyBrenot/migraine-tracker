/**
 * Browser-locale display helpers.
 *
 * `Intl.DateTimeFormat` construction is comparatively expensive and these
 * helpers run inside list rows and the 42-cell Calendar grid, so each style is
 * built once at module load. The output is identical to the previous
 * `Date#toLocale*String([], { ... })` calls.
 *
 * An unparseable date must stay non-throwing: the `toLocale*` methods return
 * the literal "Invalid Date", whereas `Intl.DateTimeFormat#format` would throw
 * a RangeError. Invalid instants are surfaced as that same text.
 */

const INVALID_DATE = 'Invalid Date';

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const DATE_FULL_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

function formatWith(d: Date, formatter: Intl.DateTimeFormat): string {
  return Number.isNaN(d.getTime()) ? INVALID_DATE : formatter.format(d);
}

export function fmtTime(iso: string): string {
  return formatWith(new Date(iso), TIME_FORMAT);
}

export function fmtDate(iso: string): string {
  return formatWith(new Date(iso), DATE_FORMAT);
}

export function fmtDateFull(iso: string): string {
  return formatWith(new Date(iso), DATE_FULL_FORMAT);
}

/** "2h 15m" / "45m" / "3d 2h" */
export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const rem = mins % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

/** Convert a Date to the value format used by <input type="datetime-local"> */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
