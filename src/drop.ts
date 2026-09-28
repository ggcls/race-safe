import type { TaskContext } from './latest'

/**
 * Discards overlapping calls while the active invocation finishes.
 *
 * @param fn - Operation receiving user arguments followed by {@link TaskContext}.
 * @returns A wrapper whose overlapping callers receive the exact active Promise,
 * including its value or unchanged rejection reason.
 *
 * @remarks
 * Dropped arguments are discarded and never executed later. The active signal is
 * not aborted. After success or failure, a future call can start immediately.
 * Synchronous throws become rejected Promises. Do not await a reentrant call
 * from within `fn`: that call shares the current execution's Promise.
 *
 * @example
 * ```ts
 * import { drop, type TaskContext } from '@ggcls/race-safe'
 *
 * const submit = drop((data: FormData, { signal }: TaskContext) =>
 *   fetch('/api/profile', { method: 'POST', body: data, signal }),
 * )
 *
 * const first = submit(new FormData())
 * const repeated = submit(new FormData()) // repeated === first
 * await first
 * ```
 */
export const drop = <
  Args extends unknown[] = [],
  Result = unknown,
  // Capturing Fn keeps generic callers from narrowing a shared result.
  Fn extends (...args: [...Args, TaskContext]) => Result = (
    ...args: [...Args, TaskContext]
  ) => Result,
>(
  fn: Fn & ((...args: [...Args, TaskContext]) => Result),
): ((...args: Args) => Promise<Awaited<Result>>) => {
  let active: Promise<Awaited<Result>> | undefined

  return (...args) => {
    if (active) {
      return active
    }

    let resolve!: (value: Awaited<Result> | PromiseLike<Awaited<Result>>) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<Awaited<Result>>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Reentrant calls need this Promise before fn runs.
    active = promise

    const execute = async () => {
      try {
        resolve(await fn(...args, { signal: new AbortController().signal }))
      } catch (error) {
        reject(error)
      } finally {
        active = undefined
      }
    }

    void execute()
    return promise
  }
}
