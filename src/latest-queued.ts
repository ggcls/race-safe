import type { TaskContext } from './latest'

/**
 * Lets active work finish, then executes only the newest pending call.
 *
 * @param fn - Operation receiving user arguments followed by {@link TaskContext}.
 * @returns A wrapper with a separate Promise for active work and one shared
 * Promise for pending callers. Replaced callers receive the surviving pending
 * execution's value or unchanged rejection reason.
 *
 * @remarks
 * Replacing pending arguments preserves that slot's exact Promise. Once the slot
 * starts executing, later calls belong to a new slot with a new Promise.
 * Active work is never aborted by another call. Rejections and synchronous throws
 * still allow pending work to start, with its own fresh signal.
 * Do not await a pending call from within `fn`: it must wait for `fn` to finish.
 *
 * @example
 * ```ts
 * import { latestQueued, type TaskContext } from '@ggcls/race-safe'
 *
 * const saveDraft = latestQueued((text: string, { signal }: TaskContext) =>
 *   fetch('/api/draft', { method: 'PUT', body: text, signal }),
 * )
 *
 * const active = saveDraft('First draft')
 * const pending = saveDraft('More edits')
 * const newest = saveDraft('Final draft') // newest === pending
 * await Promise.all([active, pending, newest])
 * ```
 */
export const latestQueued = <
  Args extends unknown[] = [],
  Result = unknown,
  // Capturing Fn keeps generic callers from narrowing a shared result.
  Fn extends (...args: [...Args, TaskContext]) => Result = (
    ...args: [...Args, TaskContext]
  ) => Result,
>(
  fn: Fn & ((...args: [...Args, TaskContext]) => Result),
): ((...args: Args) => Promise<Awaited<Result>>) => {
  interface Entry {
    args: Args
    promise: Promise<Awaited<Result>>
    resolve: (value: Awaited<Result> | PromiseLike<Awaited<Result>>) => void
    reject: (reason: unknown) => void
  }

  let running = false
  let pending: Entry | undefined

  const drain = async (entry: Entry | undefined) => {
    // Keep reentrant calls pending until the current execution finishes.
    running = true
    while (entry) {
      try {
        entry.resolve(await fn(...entry.args, { signal: new AbortController().signal }))
      } catch (error) {
        entry.reject(error)
      }

      // Clear the slot before fn can add more pending work.
      entry = pending
      pending = undefined
    }
    running = false
  }

  return (...args) => {
    if (pending) {
      pending.args = args
      return pending.promise
    }

    let resolve!: Entry['resolve']
    let reject!: Entry['reject']

    const promise = new Promise<Awaited<Result>>((res, rej) => {
      resolve = res
      reject = rej
    })

    const entry: Entry = { args, promise, resolve, reject }

    if (running) {
      pending = entry
    } else {
      void drain(entry)
    }

    return promise
  }
}
