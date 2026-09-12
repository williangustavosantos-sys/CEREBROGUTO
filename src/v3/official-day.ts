/** Stable official day identity shared by persistence and service boundaries.
 * A locale's display format is not an identifier; use explicit calendar parts. */
export function officialDayKey(now: Date, timeZone = process.env.GUTO_TIME_ZONE || "Europe/Rome"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
