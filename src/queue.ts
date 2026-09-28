import type { TaskContext } from './latest'

/**
 * Executes every call one at a time, in invocation order.
 *
 * @param fn - Operation receiving user arguments followed by {@link TaskContext}.
 * @returns A wrapper that gives each caller its own Promise for that call's
 * execution, preserving its value or rejection reason.
 *
 * @remarks
 * The first call starts immediately when idle. Later calls wait until the active
 * execution settles. Rejections and synchronous throws do not stop the queue.
 * Each execution gets a fresh signal; adding work never aborts the active one.
 * Do not await a queued call from within `fn`: it cannot start until `fn` finishes.
 *
 * @example
 * ```ts
 * import { queue, type TaskContext } from '@ggcls/race-safe'
 *
 * const updateProfile = queue((patch: { bio: string }, { signal }: TaskContext) =>
 *   fetch('/api/profile', {
 *     method: 'PATCH',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify(patch),
 *     signal,
 *   }),
 * )
 *
 * await Promise.all([
 *   updateProfile({ bio: 'Writing' }),
 *   updateProfile({ bio: 'Writing TypeScript' }),
 * ])
 * ```
 */
export const queue = <Args extends unknown[] = [], Result = unknown>(
  fn: (...args: [...Args, TaskContext]) => Result,
): ((...args: Args) => Promise<Awaited<Result>>) => {
  interface Entry {
    args: Args
    resolve: (value: Awaited<Result> | PromiseLike<Awaited<Result>>) => void
    reject: (reason: unknown) => void
    next: Entry | undefined
  }

  let head: Entry | undefined
  let tail: Entry | undefined
  let running = false

  const drain = async () => {
    // Reentrant calls must enqueue, not start another drain.
    running = true
    while (head) {
      const entry = head
      head = entry.next
      if (!head) {
        tail = undefined
      }
      entry.next = undefined

      try {
        entry.resolve(await fn(...entry.args, { signal: new AbortController().signal }))
      } catch (error) {
        entry.reject(error)
      }
    }
    running = false
  }

  return (...args) =>
    new Promise<Awaited<Result>>((resolve, reject) => {
      const entry: Entry = { args, resolve, reject, next: undefined }
      if (tail) {
        tail.next = entry
      } else {
        head = entry
      }
      tail = entry

      if (!running) {
        void drain()
      }
    })
}
