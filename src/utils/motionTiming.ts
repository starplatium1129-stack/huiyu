/** CSS minification can rewrite 260ms as .26s; WAAPI always expects milliseconds.
 * This boundary reads the project's CSS <time> tokens in either representation. */
export function cssTimeToMilliseconds(value: string): number {
  const time = value.trim()
  return Number.parseFloat(time) * (time.endsWith('ms') ? 1 : 1000)
}
