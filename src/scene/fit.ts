// Fitting text into a width; its own module so both labels and buttons can use it.

/**
 * Cut `text` to fit `maxWidth`, ending with `mark`. Returns it unchanged when it already fits.
 * `measure` gives a string's width.
 */
export function ellipsize(text: string, maxWidth: number, measure: (s: string) => number, mark = "…"): string {
  if (measure(text) <= maxWidth) return text;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid).trimEnd() + mark) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + mark;
}
