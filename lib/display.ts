/** An estimate rounded to half a foot; do not invent set-height or confidence intervals. */
export function faceLabel(feet: number | null | undefined): string {
  if (feet == null || !Number.isFinite(feet) || feet < 0) return "Unavailable";
  if (feet < 0.5) return "Flat";
  return `~${(Math.round(feet * 2) / 2).toLocaleString("en-US")} ft`;
}
export function forecastTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", timeZoneName: "short" }).format(new Date(iso));
}
