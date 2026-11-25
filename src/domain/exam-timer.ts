/** Local epoch milliseconds. Never derive the deadline from interval ticks. */
export function isExamTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function examExpirationAt(startedAt: number, durationMinutes: number): number | null {
  if (!isExamTimestamp(startedAt) || typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes)
    || durationMinutes <= 0) return null
  const durationMs = Math.round(durationMinutes * 60_000)
  const deadline = startedAt + durationMs
  return durationMs > 0 && isExamTimestamp(durationMs) && isExamTimestamp(deadline) ? deadline : null
}

export function getRemainingTimeMs(expiresAt: number | null | undefined, now: number): number | null {
  if (!isExamTimestamp(expiresAt) || !isExamTimestamp(now)) return null
  return Math.max(0, expiresAt - now)
}

export function formatExamTime(remainingMs: number): string {
  const seconds = Math.ceil((Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0) / 1000)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':')
}

/** No guessed defaults. If a suspended tab crosses several thresholds, report
 * only the most urgent observed threshold instead of replaying announcements. */
export function crossedExamWarning(
  previousRemainingMs: number,
  currentRemainingMs: number,
  warningMinutes: readonly number[],
): number | null {
  if (currentRemainingMs <= 0 || currentRemainingMs >= previousRemainingMs) return null
  const reached = warningMinutes.filter((minutes) => Number.isFinite(minutes) && minutes > 0
    && previousRemainingMs > minutes * 60_000 && currentRemainingMs <= minutes * 60_000)
  return reached.length > 0 ? Math.min(...reached) : null
}
