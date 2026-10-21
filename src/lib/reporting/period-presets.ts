/**
 * Reporting-period presets (month / quarter / half-year / year) for date-range filters.
 * Pure string math on calendar dates (YYYY-MM-DD): no Date-in-local-timezone round trips,
 * so there is no off-by-one-day risk, and nothing assumes the current year.
 */
export type PeriodKind = 'custom' | 'monthly' | 'quarterly' | 'half-yearly' | 'annually'

export interface PeriodSelection {
  year: number
  /** 1-12, used by monthly */
  month?: number
  /** 1-4, used by quarterly */
  quarter?: number
  /** 1-2, used by half-yearly */
  half?: number
}

export const PERIOD_KIND_OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: 'custom', label: 'Custom Date Range' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'half-yearly', label: 'Half-Yearly' },
  { value: 'annually', label: 'Annually' },
]

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDate = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export interface DateRange { from: string; to: string }

/** First/last calendar day of the selected period. Returns null for custom or an invalid selection. */
export function computePeriodRange(kind: PeriodKind, sel: PeriodSelection): DateRange | null {
  const { year } = sel
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null
  switch (kind) {
    case 'monthly': {
      const m = sel.month
      if (!m || !Number.isInteger(m) || m < 1 || m > 12) return null
      return { from: isoDate(year, m, 1), to: isoDate(year, m, daysInMonth(year, m)) }
    }
    case 'quarterly': {
      const q = sel.quarter
      if (!q || !Number.isInteger(q) || q < 1 || q > 4) return null
      const startMonth = (q - 1) * 3 + 1
      const endMonth = startMonth + 2
      return { from: isoDate(year, startMonth, 1), to: isoDate(year, endMonth, daysInMonth(year, endMonth)) }
    }
    case 'half-yearly': {
      const h = sel.half
      if (h !== 1 && h !== 2) return null
      return h === 1
        ? { from: isoDate(year, 1, 1), to: isoDate(year, 6, 30) }
        : { from: isoDate(year, 7, 1), to: isoDate(year, 12, 31) }
    }
    case 'annually':
      return { from: isoDate(year, 1, 1), to: isoDate(year, 12, 31) }
    default:
      return null
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export function isValidIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)
}

/** Returns an error message, or null when the range is usable. */
export function validateDateRange(from: string, to: string): string | null {
  if (!from || !to) return 'Select both a start and an end date.'
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return 'Enter valid dates.'
  if (from > to) return 'The start date cannot be after the end date.'
  return null
}

/** Seeds the period selectors from an existing date so switching presets keeps the user's context. */
export function selectionFromDate(date: string, fallbackYear: number): PeriodSelection {
  const m = DATE_RE.exec(date)
  if (!m) return { year: fallbackYear, month: 1, quarter: 1, half: 1 }
  const year = Number(m[1])
  const month = Number(m[2])
  return { year, month, quarter: Math.ceil(month / 3), half: month <= 6 ? 1 : 2 }
}
