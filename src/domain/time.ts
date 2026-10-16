// 表示・業務日は Asia/Tokyo。保存は UTC の ISO 文字列。
const TZ = 'Asia/Tokyo';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const weekdayFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, weekday: 'short' });

/** ISO 日時 → 東京の業務日 YYYY-MM-DD */
export function tokyoDate(iso: string | Date): string {
  return dateFmt.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function tokyoTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function tokyoDateTime(iso: string): string {
  return `${tokyoDate(iso).replace(/-/g, '/')} ${tokyoTime(iso)}`;
}

export function formatBusinessDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00+09:00`);
  return `${ymd.replace(/-/g, '.')}（${weekdayFmt.format(d)}）`;
}

/** 東京の業務日 + 時刻 → ISO(UTC) */
export function tokyoToIso(ymd: string, hhmm: string): string {
  return new Date(`${ymd}T${hhmm}:00+09:00`).toISOString();
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return tokyoDate(d);
}
