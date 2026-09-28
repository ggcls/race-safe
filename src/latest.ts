/** Context injected as the final argument of each executed call. */
export interface TaskContext {
  /**
   * Cooperative cancellation signal for this execution.
   * `latest` aborts it when superseded while active; the other strategies leave it active.
   */
  signal: AbortSignal
}

/**
 * Starts every call immediately and aborts the previous active call's signal.
 *
 * @param fn - Operation receiving user arguments followed by {@link TaskContext}.
 * @returns A wrapper that accepts the user arguments and returns a distinct
 * Promise for each invocation, preserving its value or rejection reason.
 *
 * @remarks
 * Cancellation is cooperative: superseded work can still resolve or reject if
 * it ignores the signal. Its Promise is never replaced by a newer call's Promise.
 * Synchronous return values and throws are normalized to Promise settlement.
 *
 * @example
 * ```ts
 * import { latest, type TaskContext } from '@ggcls/race-safe'
 *
 * const search = latest((query: string, { signal }: TaskContext) =>
 *   fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal }),
 * )
 *
 * const results = await Promise.allSettled([search('rea'), search('react')])
 * ```
 */
export const latest = <Args extends unknown[] = [], Result = unknown>(
  fn: (...args: [...Args, TaskContext]) => Result,
): ((...args: Args) => Promise<Awaited<Result>>) => {
  let active: AbortController | undefined

  return async (...args: Args): Promise<Awaited<Result>> => {
    const controller = new AbortController()
    const previous = active
    // Abort listeners can call this wrapper again.
    active = controller

    try {
      previous?.abort()
      return await fn(...args, { signal: controller.signal })
    } finally {
      // An older call can finish after a newer one has started.
      if (active === controller) active = undefined
    }
  }
}
