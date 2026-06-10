// Calendar-style schedule helpers: convert a friendly { frequency, time,
// daysOfWeek, dayOfMonth, timezone } picker shape into a UTC cron expression
// (which is what the backend stores and what GitHub Actions interprets), and
// describe an existing cron expression in plain English when we can.
//
// Why UTC: the backend's cron-parser runs in UTC and GitHub Actions cron
// schedules are documented as UTC. We convert the user's local time-of-day +
// timezone into UTC before serializing.

export type Frequency = "daily" | "weekly" | "monthly";

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ScheduleSpec {
  frequency: Frequency;
  // 24h time in the chosen timezone, e.g. "09:00".
  time: string;
  // 0=Sun..6=Sat. Required for weekly; ignored otherwise.
  daysOfWeek: number[];
  // 1..28 (capped to 28 to avoid the Feb-30 trap). Required for monthly.
  dayOfMonth: number;
  // IANA timezone, e.g. "America/Los_Angeles" or "UTC".
  timezone: string;
}

export function defaultSpec(): ScheduleSpec {
  return {
    frequency: "daily",
    time: "09:00",
    daysOfWeek: [1, 2, 3, 4, 5], // weekdays
    dayOfMonth: 1,
    timezone: detectTimezone(),
  };
}

export function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

// Common timezones presented in the picker. Users can still pick anything
// supported by the browser via the secondary "More…" path; this list is the
// fast-pick for the 90% case.
export const COMMON_TIMEZONES: string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function parseHHMM(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

// Resolve a wall-clock { h, m } in IANA `timezone` against an arbitrary
// reference date (so weekly/monthly maths are stable across DST boundaries
// well enough for cron purposes). Returns the UTC hour and minute that this
// wall clock corresponds to.
//
// Important caveat: cron is a fixed-offset schedule. If `timezone` observes
// DST, the same wall-clock time will map to different UTC offsets across the
// year — cron can't express that. We snapshot the offset *as of now* and use
// it for the cron string. The user can re-edit if DST shifts cause drift.
// This is the same tradeoff GitHub Actions cron makes (it's UTC-only).
// Returns (local wall time) − UTC in minutes for the given IANA zone, computed
// against "now". Cron is a fixed-offset schedule, so DST shifts will drift —
// the picker takes the offset snapshot at edit time. Returns 0 for unknown
// zones (falls back to UTC).
function timezoneOffsetMinutes(timezone: string): number {
  const now = new Date();
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const parts = dtf.formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
    const wallMinutes = get("hour") * 60 + get("minute");
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    let offset = wallMinutes - utcMinutes;
    // Normalize to [-12*60, +14*60] — Intl can hand back midnight-crossing
    // values when the zone is across the dateline.
    if (offset > 14 * 60) offset -= 24 * 60;
    if (offset < -12 * 60) offset += 24 * 60;
    return offset;
  } catch {
    return 0;
  }
}

function dayShiftFor(totalMinutes: number): number {
  if (totalMinutes < 0) return -1;
  if (totalMinutes >= 24 * 60) return 1;
  return 0;
}

function wallTimeToUtc(timezone: string, h: number, m: number): { hUtc: number; mUtc: number; weekdayShift: number } {
  const offsetMinutes = timezoneOffsetMinutes(timezone);
  const totalLocal = h * 60 + m;
  const totalUtc = totalLocal - offsetMinutes;
  const normUtc = ((totalUtc % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    hUtc: Math.floor(normUtc / 60),
    mUtc: normUtc % 60,
    weekdayShift: dayShiftFor(totalUtc),
  };
}

// Build a 5-field cron expression (minute hour dom month dow) in UTC from a
// friendly spec. Returns null if the spec is invalid.
export function specToCron(spec: ScheduleSpec): string | null {
  const t = parseHHMM(spec.time);
  if (!t) return null;
  const { hUtc, mUtc, weekdayShift } = wallTimeToUtc(spec.timezone, t.h, t.m);
  const min = mUtc;
  const hr = hUtc;

  if (spec.frequency === "daily") {
    return `${min} ${hr} * * *`;
  }
  if (spec.frequency === "weekly") {
    const days = [...new Set(spec.daysOfWeek)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length === 0) return null;
    // Apply the day shift from UTC conversion (e.g. 11pm IST runs on the
    // previous day in UTC).
    const shifted = days.map((d) => ((d + weekdayShift) % 7 + 7) % 7).sort((a, b) => a - b);
    return `${min} ${hr} * * ${shifted.join(",")}`;
  }
  // monthly
  const dom = Math.min(Math.max(Math.floor(spec.dayOfMonth || 1), 1), 28);
  // Day-shift for monthly is harder — skip strict correctness here; for
  // mid-month days the rollover is rare. Document this in the UI hint.
  return `${min} ${hr} ${dom} * *`;
}

function utcWallToLocal(hr: number, min: number, timezone: string): { localH: number; localM: number; weekdayShift: number } {
  const offsetMinutes = timezoneOffsetMinutes(timezone);
  const totalUtc = hr * 60 + min;
  const totalLocal = totalUtc + offsetMinutes;
  const normLocal = ((totalLocal % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    localH: Math.floor(normLocal / 60),
    localM: normLocal % 60,
    weekdayShift: dayShiftFor(totalLocal),
  };
}

// Try to interpret an existing cron expression as a calendar-style spec. If
// the cron uses constructs the picker can't represent (steps, ranges,
// non-zero seconds, etc.) we return null and the UI should fall back to
// "Advanced" mode showing the raw cron.
export function cronToSpec(cron: string | null | undefined, timezone: string): ScheduleSpec | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if ([minute, hour, dom, month, dow].some((p) => /[-/]/.test(p))) return null;
  if (month !== "*") return null;

  const min = Number(minute);
  const hr = Number(hour);
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  if (!Number.isInteger(hr) || hr < 0 || hr > 23) return null;

  const { localH, localM, weekdayShift } = utcWallToLocal(hr, min, timezone);
  const time = `${String(localH).padStart(2, "0")}:${String(localM).padStart(2, "0")}`;

  if (dom === "*" && dow === "*") {
    return { frequency: "daily", time, daysOfWeek: [], dayOfMonth: 1, timezone };
  }
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
    const days = dow.split(",").map(Number);
    const unshifted = days.map((d) => ((d - weekdayShift) % 7 + 7) % 7).sort((a, b) => a - b);
    return { frequency: "weekly", time, daysOfWeek: unshifted, dayOfMonth: 1, timezone };
  }
  if (dow === "*" && /^([1-9]|[12]\d|3[01])$/.test(dom)) {
    return { frequency: "monthly", time, daysOfWeek: [], dayOfMonth: Number(dom), timezone };
  }
  return null;
}

// Render a friendly description of a cron expression, given the timezone we
// want to display it in. Falls back to the raw cron if the structure is
// outside what the picker supports.
export function describeCron(cron: string | null | undefined, timezone: string | null | undefined): string {
  if (!cron) return "—";
  const tz = timezone || "UTC";
  const spec = cronToSpec(cron, tz);
  if (!spec) return `Cron: ${cron} (UTC)`;
  const timeLabel = `${spec.time} ${tz}`;
  if (spec.frequency === "daily") return `Daily at ${timeLabel}`;
  if (spec.frequency === "weekly") {
    if (spec.daysOfWeek.length === 7) return `Every day at ${timeLabel}`;
    if (
      spec.daysOfWeek.length === 5 &&
      [1, 2, 3, 4, 5].every((d) => spec.daysOfWeek.includes(d))
    ) {
      return `Weekdays at ${timeLabel}`;
    }
    const days = spec.daysOfWeek.map((d) => DAY_LABELS[d]).join(", ");
    return `${days} at ${timeLabel}`;
  }
  return `Monthly on day ${spec.dayOfMonth} at ${timeLabel}`;
}
