import { t } from '../i18n/index.ts';

/*
 * Dates are shown in UTC, with the zone named. The server renders pages before the browser
 * does, and formatting in each side's own time zone would make the two disagree.
 */

// dateStyle and timeStyle cannot be combined with timeZoneName, so the parts are listed.
const dateTime = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A date as docs/design/docs/copy.md writes it: "Oct 1". In UTC, like every date here. */
export function formatDay(iso: string): string {
  return day.format(new Date(iso));
}

const dayAndYear = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A date that may be in another year, such as when a workspace was created: "Mar 4, 2026". */
export function formatDayAndYear(iso: string): string {
  return dayAndYear.format(new Date(iso));
}

/** A file size for people: "840 bytes", "12 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A duration as docs/design/docs/copy.md writes it, and as a screen reader should say it:
 * 4 -> "4 ms" / "4 milliseconds", 2410 -> "2.41 s", 23_900 -> "23.9 s" / "23.9 seconds".
 * Under ten seconds gets two decimals, longer one.
 */
export function formatDuration(ms: number): { text: string; spoken: string } {
  if (ms < 1000) {
    const n = String(Math.round(ms));
    return {
      text: t('duration.ms', { n }),
      spoken: t(n === '1' ? 'duration.msSpokenOne' : 'duration.msSpoken', { n }),
    };
  }
  const n = (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
  return { text: t('duration.s', { n }), spoken: t('duration.sSpoken', { n }) };
}

const clock = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** A time of day, 24-hour, in UTC: "03:17". */
export function formatClock(iso: string): string {
  return clock.format(new Date(iso));
}
