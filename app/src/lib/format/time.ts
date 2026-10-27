// The one place the UI turns a time into text. Every value shown is in the user's own locale and
// time zone (a tally controller has no business zone), so these pass `undefined` for the locale.

/**
 * A release's publish instant (RFC 3339) as the user's local date, e.g. "20 October 2026"; null
 * when the release carries no date or it doesn't parse.
 */
export function formatReleaseDate(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** A wall-clock time of day, e.g. "14:05". */
export function formatClockTime(d: Date): string {
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
