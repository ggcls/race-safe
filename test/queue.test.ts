import type { TaskContext } from '../src/index'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { queue } from '../src/index'
import { deferred } from './helpers/deferred'

describe('queue', () => {
  it('starts immediately and passes arguments and results through', async () => {
    const input = { name: 'Ada' }
    const result = { saved: true }
    let started = false
    const run = queue(async (data: typeof input, revision: number, { signal }: TaskContext) => {
      started = true
      expect(data).toBe(input)
      expect(revision).toBe(2)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
      return result
    })
    const promise = run(input, 2)
    expect(started).toBe(true)
    await expect(promise).resolves.toBe(result)
  })

  it('runs one call at a time in FIFO order', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const started: number[] = []
    const signals: AbortSignal[] = []
    let active = 0
    let maximum = 0
    const run = queue(async (index: number, { signal }: TaskContext) => {
      started.push(index)
      signals.push(signal)
      active++
      maximum = Math.max(maximum, active)
      try {
        return await gates[index]!.promise
      }
      finally {
        active--
      }
    })
    const a = run(0)
    const b = run(1)
    const c = run(2)
    expect(new Set([a, b, c]).size).toBe(3)
    expect(started).toEqual([0])
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)
    gates[0]!.resolve('A')
    await expect(a).resolves.toBe('A')
    expect(started).toEqual([0, 1])
    expect(signals[1]!.aborted).toBe(false)
    gates[1]!.resolve('B')
    await expect(b).resolves.toBe('B')
    expect(started).toEqual([0, 1, 2])
    gates[2]!.resolve('C')
    await expect(c).resolves.toBe('C')
    expect(active).toBe(0)
    expect(maximum).toBe(1)
    expect(new Set(signals).size).toBe(3)
    expect(signals.every(signal => signal instanceof AbortSignal && !signal.aborted)).toBe(true)
    const again = run(0)
    expect(started).toEqual([0, 1, 2, 0])
    await expect(again).resolves.toBe('A')
    expect(signals[3]).not.toBe(signals[0])
  })

  it('preserves B\'s error and continues to C', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const started: number[] = []
    const error = new Error('B failed')
    const run = queue((index: number, _context: TaskContext) => {
      started.push(index)
      return gates[index]!.promise
    })
    const a = run(0)
    const b = run(1)
    const c = run(2)
    const rejected = expect(b).rejects.toBe(error)
    gates[0]!.resolve('A')
    await expect(a).resolves.toBe('A')
    expect(started).toEqual([0, 1])
    gates[1]!.reject(error)
    await rejected
    expect(started).toEqual([0, 1, 2])
    gates[2]!.resolve('C')
    await expect(c).resolves.toBe('C')
  })

  it('recovers from synchronous throws while busy or idle', async () => {
    const gate = deferred<string>()
    const error = { reason: 'synchronous failure' }
    const started: string[] = []
    const run = queue((name: string, _context: TaskContext) => {
      started.push(name)
      if (name === 'B')
        throw error
      return name === 'A' ? gate.promise : name
    })
    const a = run('A')
    const b = run('B')
    const rejected = expect(b).rejects.toBe(error)
    const c = run('C')
    gate.resolve('A')
    await expect(a).resolves.toBe('A')
    await rejected
    await expect(c).resolves.toBe('C')
    expect(started).toEqual(['A', 'B', 'C'])
    let failed!: Promise<string>
    expect(() => {
      failed = run('B')
    }).not.toThrow()
    await expect(failed).rejects.toBe(error)
    const d = run('D')
    expect(started).toEqual(['A', 'B', 'C', 'B', 'D'])
    await expect(d).resolves.toBe('D')
  })

  it('returns to idle after asynchronous failure', async () => {
    const gate = deferred<string>()
    const error = new Error('failed')
    const started: string[] = []
    const run = queue((name: string, _context: TaskContext) => {
      started.push(name)
      return name === 'A' ? gate.promise : name
    })
    const rejected = expect(run('A')).rejects.toBe(error)
    gate.reject(error)
    await rejected
    const b = run('B')
    expect(started).toEqual(['A', 'B'])
    await expect(b).resolves.toBe('B')
  })

  it('queues synchronous reentrant calls without recursive execution', async () => {
    const gate = deferred<string>()
    const started: string[] = []
    let nested!: Promise<string>
    let insideA = false
    const run: (name: string) => Promise<string> = queue((name: string, _context: TaskContext) => {
      started.push(name)
      if (name === 'A') {
        insideA = true
        nested = run('B')
        expect(started).toEqual(['A'])
        insideA = false
        return gate.promise
      }
      expect(insideA).toBe(false)
      return name
    })
    const a = run('A')
    const c = run('C')
    expect(nested).not.toBe(a)
    expect(started).toEqual(['A'])
    gate.resolve('A')
    await expect(a).resolves.toBe('A')
    await expect(nested).resolves.toBe('B')
    await expect(c).resolves.toBe('C')
    expect(started).toEqual(['A', 'B', 'C'])
  })

  it('appends reentrant calls after an await to the end of the queue', async () => {
    const gate = deferred<void>()
    const started: string[] = []
    let nested!: Promise<string>
    const run: (name: string) => Promise<string> = queue(async (name: string, _context: TaskContext) => {
      started.push(name)
      if (name === 'A') {
        await gate.promise
        nested = run('C')
        expect(started).toEqual(['A'])
      }
      return name
    })
    const a = run('A')
    const b = run('B')
    gate.resolve(undefined)
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
    await expect(nested).resolves.toBe('C')
    expect(started).toEqual(['A', 'B', 'C'])
  })

  it('keeps FIFO order when a result handler enqueues another call', async () => {
    const started: string[] = []
    const run = queue((name: string, _context: TaskContext) => {
      started.push(name)
      return name
    })
    const a = run('A').then(() => run('D'))
    const b = run('B')
    const c = run('C')
    await expect(Promise.all([a, b, c])).resolves.toEqual(['D', 'B', 'C'])
    expect(started).toEqual(['A', 'B', 'C', 'D'])
  })

  it('drains a large queue of immediate Promises in order', async () => {
    const order: number[] = []
    const run = queue((value: number, _context: TaskContext) => {
      order.push(value)
      return Promise.resolve(value)
    })
    const expected = Array.from({ length: 10_000 }, (_, index) => index)
    const results = expected.map(value => run(value))
    expect(order).toEqual([0])
    await expect(Promise.all(results)).resolves.toEqual(expected)
    expect(order).toEqual(expected)
  })

  it('drains synchronous failures without growing the call stack', async () => {
    const gate = deferred<number>()
    const error = new Error('failed')
    const order: number[] = []
    const run = queue((value: number, _context: TaskContext) => {
      order.push(value)
      if (value === 0)
        return gate.promise
      throw error
    })
    const expected = Array.from({ length: 2000 }, (_, index) => index)
    const results = Promise.allSettled(expected.map(value => run(value)))
    gate.resolve(0)
    const settled = await results
    expect(settled[0]).toEqual({ status: 'fulfilled', value: 0 })
    for (const result of settled.slice(1))
      expect(result).toEqual({ status: 'rejected', reason: error })
    expect(order).toEqual(expected)
  })

  it('creates no unhandled rejections when callers handle their errors', async () => {
    const errors: unknown[] = []
    const onUnhandled = (error: unknown) => {
      errors.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const error = new Error('immediate rejection')
      const run = queue((fail: boolean, _context: TaskContext) =>
        fail ? Promise.reject(error) : Promise.resolve('ok'),
      )
      const failed = expect(run(true)).rejects.toBe(error)
      const success = expect(run(false)).resolves.toBe('ok')
      await Promise.all([failed, success])
      // Let Node report unhandled rejections before checking.
      await nextTurn()
      expect(errors).toEqual([])
    }
    finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps wrapper instances independent', async () => {
    const gate = deferred<string>()
    const first = queue(() => gate.promise)
    const second = queue(() => 'second')
    const a = first()
    await expect(second()).resolves.toBe('second')
    gate.resolve('first')
    await expect(a).resolves.toBe('first')
  })
})
