import type { TaskContext } from '../src/index'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { drop } from '../src/index'
import { deferred } from './helpers/deferred'

describe('drop', () => {
  it('passes arguments and context through and returns the result', async () => {
    const data = { name: 'Ada' }
    const result = { id: 42 }
    const run = drop(async (input: typeof data, version: number, { signal }: TaskContext) => {
      expect(input).toBe(data)
      expect(version).toBe(2)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
      return result
    })
    await expect(run(data, 2)).resolves.toBe(result)
  })

  it('shares the active Promise and discards overlapping calls', async () => {
    const completion = deferred<{ id: number }>()
    const calls: string[] = []
    const signals: AbortSignal[] = []
    const run = drop((name: string, { signal }: TaskContext) => {
      calls.push(name)
      signals.push(signal)
      return completion.promise
    })
    const a = run('A')
    const b = run('B')
    const c = run('C')
    expect(calls).toEqual(['A'])
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(signals[0]!.aborted).toBe(false)
    const value = { id: 42 }
    completion.resolve(value)
    for (const promise of [a, b, c]) await expect(promise).resolves.toBe(value)
    expect(calls).toEqual(['A'])
    const d = run('D')
    expect(d).not.toBe(a)
    await expect(d).resolves.toBe(value)
    expect(calls).toEqual(['A', 'D'])
    expect(signals[1]).not.toBe(signals[0])
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
  })

  it('shares errors with dropped callers and accepts new calls afterward', async () => {
    const completion = deferred<string>()
    const error = new Error('save failed')
    const calls: string[] = []
    const signals: AbortSignal[] = []
    const run = drop((name: string, { signal }: TaskContext) => {
      calls.push(name)
      signals.push(signal)
      return name === 'A' ? completion.promise : Promise.resolve(name)
    })
    const a = run('A')
    const b = run('B')
    const c = run('C')
    expect(b).toBe(a)
    expect(c).toBe(a)
    const rejected = [a, b, c].map((promise) => expect(promise).rejects.toBe(error))
    completion.reject(error)
    await Promise.all(rejected)
    await expect(run('D')).resolves.toBe('D')
    expect(calls).toEqual(['A', 'D'])
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
  })

  it('rejects on a synchronous throw and accepts the next call', async () => {
    const error = { reason: 'synchronous failure' }
    const run = drop((fail: boolean, _context: TaskContext) => {
      if (fail) throw error
      return 42
    })
    let failed!: Promise<number>
    expect(() => {
      failed = run(true)
    }).not.toThrow()
    const rejected = expect(failed).rejects.toBe(error)
    await expect(run(false)).resolves.toBe(42)
    await rejected
  })

  it('shares an immediately resolved Promise until settlement', async () => {
    const calls: number[] = []
    const run = drop((value: number, _context: TaskContext) => {
      calls.push(value)
      return Promise.resolve(value)
    })
    const a = run(1)
    expect(run(2)).toBe(a)
    await expect(a).resolves.toBe(1)
    await expect(run(3)).resolves.toBe(3)
    expect(calls).toEqual([1, 3])
  })

  it('shares synchronous results with overlapping callers', async () => {
    const run = drop((value: number, _context: TaskContext) => value)
    const a = run(1)
    expect(run(2)).toBe(a)
    await expect(a).resolves.toBe(1)
    await expect(run(3)).resolves.toBe(3)
  })

  it('shares the active Promise with synchronous reentrant calls', async () => {
    const completion = deferred<string>()
    const calls: string[] = []
    let nested!: Promise<string>
    const run: (name: string) => Promise<string> = drop((name: string, _context: TaskContext) => {
      calls.push(name)
      nested = run('nested')
      return completion.promise
    })
    const a = run('A')
    expect(nested).toBe(a)
    expect(calls).toEqual(['A'])
    completion.resolve('saved')
    await expect(nested).resolves.toBe('saved')
    await expect(run('B')).resolves.toBe('saved')
    expect(calls).toEqual(['A', 'B'])
  })

  it('drops a reentrant invocation after an await', async () => {
    const gate = deferred<void>()
    const calls: string[] = []
    let nested!: Promise<string>
    const run: (name: string) => Promise<string> = drop(
      async (name: string, _context: TaskContext) => {
        calls.push(name)
        await gate.promise
        nested = run('nested')
        return name
      },
    )
    const a = run('A')
    gate.resolve(undefined)
    await expect(a).resolves.toBe('A')
    expect(nested).toBe(a)
    expect(calls).toEqual(['A'])
    await expect(run('B')).resolves.toBe('B')
  })

  it('shares a synchronous failure with a reentrant caller and then recovers', async () => {
    const error = new Error('failure after reentry')
    let nested!: Promise<string>
    const run: (fail: boolean) => Promise<string> = drop((fail: boolean, _context: TaskContext) => {
      if (fail) {
        nested = run(false)
        throw error
      }
      return 'recovered'
    })
    const a = run(true)
    expect(nested).toBe(a)
    await expect(nested).rejects.toBe(error)
    await expect(run(false)).resolves.toBe('recovered')
  })

  it('clears state before result handlers run', async () => {
    const run = drop((value: number, _context: TaskContext) =>
      value < 0 ? Promise.reject(value) : Promise.resolve(value),
    )
    await expect(run(1).then(() => run(2))).resolves.toBe(2)
    await expect(run(-1).catch(() => run(3))).resolves.toBe(3)
  })

  it('creates no unhandled rejections when the active error is handled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const error = new Error('rejected immediately')
      const run = drop(() => Promise.reject(error))
      const a = run()
      expect(run()).toBe(a)
      expect(run()).toBe(a)
      await expect(a).rejects.toBe(error)
      // Let Node report unhandled rejections before checking.
      await nextTurn()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps separate wrapper instances independent', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const starts: string[] = []
    const a = drop(() => {
      starts.push('A')
      return first.promise
    })
    const b = drop(() => {
      starts.push('B')
      return second.promise
    })
    const resultA = a()
    const resultB = b()
    expect(starts).toEqual(['A', 'B'])
    first.resolve('A')
    second.resolve('B')
    await expect(resultA).resolves.toBe('A')
    await expect(resultB).resolves.toBe('B')
  })
})
