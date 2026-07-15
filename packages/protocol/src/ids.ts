import { z } from "zod";

/**
 * Every identifier crossing a Hall trust boundary must be a non-blank,
 * length-bounded string. The upper bound exists so a hostile or buggy
 * process cannot smuggle unbounded-size data into an "id" field.
 */
export const nonEmptyIdSchema = z
  .string()
  .min(1, "must not be empty")
  .max(128, "must not exceed 128 characters")
  .refine((value) => value.trim().length > 0, "must not be blank");

/**
 * Same shape as an id, but for free-text fields such as titles, where the
 * maximum length is caller-supplied instead of the fixed id length.
 */
export function boundedNonBlankString(maxLength: number) {
  return z
    .string()
    .min(1, "must not be empty")
    .max(maxLength, `must not exceed ${String(maxLength)} characters`)
    .refine((value) => value.trim().length > 0, "must not be blank");
}

const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * Validates the calendar/time components of an already regex-matched ISO
 * 8601 timestamp by reconstructing them with `Date.UTC` and checking the
 * result round-trips back to the same year/month/day. This is deliberately
 * not just `!Number.isNaN(Date.parse(value))`: `Date.parse` behavior for
 * out-of-range calendar dates (e.g. day 30 in February) is not guaranteed
 * identical across JS engines, so validity here is decided by us, not by
 * whichever engine happens to run this code.
 */
function hasValidCalendarComponents(match: RegExpExecArray): boolean {
  const [
    ,
    yearStr,
    monthStr,
    dayStr,
    hourStr,
    minuteStr,
    secondStr,
    fractionStr,
    utcMarker,
    _offsetSign,
    offsetHourStr,
    offsetMinuteStr,
  ] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  const millisecond = fractionStr === undefined ? 0 : Number(fractionStr.padEnd(3, "0"));

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (utcMarker === undefined) {
    const offsetHour = Number(offsetHourStr);
    const offsetMinute = Number(offsetMinuteStr);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  const reconstructed = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return (
    !Number.isNaN(reconstructed.getTime()) &&
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() === month - 1 &&
    reconstructed.getUTCDate() === day
  );
}

/**
 * ISO 8601 timestamp string. Hall messages never carry JavaScript `Date`
 * objects on the wire because `Date` does not survive JSON round-tripping
 * predictably and is not a valid type in a cross-process, cross-language
 * protocol; a fixed-format string is unambiguous everywhere.
 */
export const isoTimestampSchema = z
  .string()
  .max(40, "must not exceed 40 characters")
  .refine((value) => {
    const match = ISO_8601_PATTERN.exec(value);
    return match !== null && hasValidCalendarComponents(match);
  }, "must be a valid ISO 8601 timestamp (e.g. 2026-07-15T12:00:00.000Z)");
