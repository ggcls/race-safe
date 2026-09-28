import type { TaskContext } from '../src/index'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { latestQueued } from '../src/index'
import { deferred } from './helpers/deferred'

const setup = () => {
  const gates = new Map<string, ReturnType<typeof deferred<string>>>()
  const signals = new Map<string, AbortSignal>()
  const events: string[] = []
  let active = 0
  let maximum = 0
  const run = latestQueued(async (name: string, { signal }: TaskContext) => {
    const gate = deferred<string>()
    gates.set(name, gate)
    signals.set(name, signal)
    events.push(`start ${name}`)
    active++
    maximum = Math.max(maximum, active)
    try {
      return await gate.promise
    }
    finally {
      active--
      events.push(`finish ${name}`)
    }
  })
  return {
    run,
    events,
    signals,
    gate: (name: string) => gates.get(name)!,
    active: () => active,
    maximum: () => maximum,
  }
}

describe('latestQueued', () => {
  it('starts immediately and passes arguments and results through', async () => {
    const draft = { text: 'hello' }
    const result = { version: 2 }
    let started = false
    const run = latestQueued(async (input: typeof draft, version: number, { signal }: TaskContext) => {
      started = true
      expect(input).toBe(draft)
      expect(version).toBe(2)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
      return result
    })
    const promise = run(draft, 2)
    expect(started).toBe(true)
    await expect(promise).resolves.toBe(result)
  })

  it.each([
    ['B'],
    ['B', 'C'],
    ['B', 'C', 'D'],
    ['B', 'C', 'D', 'E'],
  ])('keeps one pending slot for calls %j', async (...names: string[]) => {
    const task = setup()
    const a = task.run('A')
    const pending = names.map(name => task.run(name))
    expect(new Set(pending).size).toBe(1)
    expect(pending[0]).not.toBe(a)
    expect(task.events).toEqual(['start A'])
    expect(task.signals.size).toBe(1)
    expect(task.signals.get('A')!.aborted).toBe(false)
    task.gate('A').resolve('A result')
    await expect(a).resolves.toBe('A result')
    const survivor = names.at(-1)!
    expect(task.events).toEqual(['start A', 'finish A', `start ${survivor}`])
    expect(task.signals.get(survivor)).toBeInstanceOf(AbortSignal)
    expect(task.signals.get(survivor)).not.toBe(task.signals.get('A'))
    task.gate(survivor).resolve('survivor result')
    for (const promise of pending)
      await expect(promise).resolves.toBe('survivor result')
    expect(task.events).toEqual(['start A', 'finish A', `start ${survivor}`, `finish ${survivor}`])
    expect(task.maximum()).toBe(1)
    expect(task.active()).toBe(0)
    expect([...task.signals.values()].every(signal => !signal.aborted)).toBe(true)
    const fresh = task.run('fresh')
    expect(task.events.at(-1)).toBe('start fresh')
    expect(fresh).not.toBe(pending[0])
    task.gate('fresh').resolve('fresh result')
    await expect(fresh).resolves.toBe('fresh result')
  })

  it('shares the pending error with replaced callers and recovers', async () => {
    const task = setup()
    const error = new Error('survivor failed')
    const a = task.run('A')
    const b = task.run('B')
    const c = task.run('C')
    const d = task.run('D')
    expect(b).toBe(c)
    expect(c).toBe(d)
    const rejected = [b, c, d].map(promise => expect(promise).rejects.toBe(error))
    task.gate('A').resolve('A')
    await expect(a).resolves.toBe('A')
    task.gate('D').reject(error)
    await Promise.all(rejected)
    expect(task.events).toEqual(['start A', 'finish A', 'start D', 'finish D'])
    const e = task.run('E')
    expect(task.events.at(-1)).toBe('start E')
    task.gate('E').resolve('recovered')
    await expect(e).resolves.toBe('recovered')
  })

  it('continues pending work after the active call rejects', async () => {
    const task = setup()
    const error = { reason: 'A failed' }
    const a = task.run('A')
    const rejected = expect(a).rejects.toBe(error)
    const b = task.run('B')
    const c = task.run('C')
    task.gate('A').reject(error)
    await rejected
    expect(task.events).toEqual(['start A', 'finish A', 'start C'])
    task.gate('C').resolve('C result')
    await expect(b).resolves.toBe('C result')
    await expect(c).resolves.toBe('C result')
    expect(task.maximum()).toBe(1)
  })

  it('opens a new pending slot when the previous one starts', async () => {
    const task = setup()
    const a = task.run('A')
    const b = task.run('B')
    const c = task.run('C')
    task.gate('A').resolve('A')
    await a
    const d = task.run('D')
    const e = task.run('E')
    expect(d).toBe(e)
    expect(d).not.toBe(c)
    expect(b).toBe(c)
    expect(task.events).toEqual(['start A', 'finish A', 'start C'])
    task.gate('C').resolve('C')
    await expect(b).resolves.toBe('C')
    await expect(c).resolves.toBe('C')
    expect(task.events.at(-1)).toBe('start E')
    task.gate('E').resolve('E')
    await expect(d).resolves.toBe('E')
    await expect(e).resolves.toBe('E')
    expect(task.maximum()).toBe(1)
  })

  it('replaces pending calls during reentry from successive executions', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<string>>>()
    const calls = new Map<string, Promise<string>>()
    const events: string[] = []
    let active = 0
    let maximum = 0
    const run: (name: string) => Promise<string> = latestQueued(async (name: string, _context: TaskContext) => {
      events.push(`start ${name}`)
      active++
      maximum = Math.max(maximum, active)
      const gate = deferred<string>()
      gates.set(name, gate)
      if (name === 'A') {
        calls.set('B', run('B'))
        calls.set('C', run('C'))
        expect(events).toEqual(['start A'])
      }
      if (name === 'C') {
        calls.set('D', run('D'))
        calls.set('E', run('E'))
        expect(events).toEqual(['start A', 'finish A', 'start C'])
      }
      try {
        return await gate.promise
      }
      finally {
        active--
        events.push(`finish ${name}`)
      }
    })
    const a = run('A')
    expect(calls.get('B')).toBe(calls.get('C'))
    expect(calls.get('B')).not.toBe(a)
    gates.get('A')!.resolve('A')
    await a
    expect(calls.get('D')).toBe(calls.get('E'))
    expect(calls.get('D')).not.toBe(calls.get('C'))
    gates.get('C')!.resolve('C')
    await expect(calls.get('B')!).resolves.toBe('C')
    gates.get('E')!.resolve('E')
    await expect(calls.get('D')!).resolves.toBe('E')
    expect(events).toEqual(['start A', 'finish A', 'start C', 'finish C', 'start E', 'finish E'])
    expect(active).toBe(0)
    expect(maximum).toBe(1)
  })

  it('runs the newest reentrant call after a synchronous throw', async () => {
    const error = new Error('A threw')
    const events: string[] = []
    let b!: Promise<string>
    let c!: Promise<string>
    const run: (name: string) => Promise<string> = latestQueued((name: string, _context: TaskContext) => {
      events.push(name)
      if (name === 'A') {
        b = run('B')
        c = run('C')
        throw error
      }
      return name
    })
    let a!: Promise<string>
    expect(() => {
      a = run('A')
    }).not.toThrow()
    await expect(a).rejects.toBe(error)
    expect(b).toBe(c)
    await expect(b).resolves.toBe('C')
    expect(events).toEqual(['A', 'C'])
    await expect(run('D')).resolves.toBe('D')
  })

  it('recovers from synchronous throws while busy or idle', async () => {
    const gate = deferred<string>()
    const error = { reason: 'synchronous failure' }
    const events: string[] = []
    const run = latestQueued((name: string, _context: TaskContext) => {
      events.push(name)
      if (name === 'fail')
        throw error
      return name === 'A' ? gate.promise : name
    })
    const a = run('A')
    const b = run('B')
    const failed = run('fail')
    expect(b).toBe(failed)
    const rejected = expect(b).rejects.toBe(error)
    gate.resolve('A')
    await a
    await rejected
    await expect(run('fail')).rejects.toBe(error)
    await expect(run('recovered')).resolves.toBe('recovered')
    expect(events).toEqual(['A', 'fail', 'fail', 'recovered'])
  })

  it('runs the next pending call after the previous one rejects', async () => {
    const task = setup()
    const error = new Error('C failed')
    const a = task.run('A')
    const b = task.run('B')
    const c = task.run('C')
    const rejected = expect(c).rejects.toBe(error)
    task.gate('A').resolve('A')
    await a
    const d = task.run('D')
    const e = task.run('E')
    task.gate('C').reject(error)
    await rejected
    expect(b).toBe(c)
    expect(task.events.at(-1)).toBe('start E')
    task.gate('E').resolve('E')
    await expect(d).resolves.toBe('E')
    await expect(e).resolves.toBe('E')
  })

  it.each(['value', 'promise', 'thenable'])('handles immediate %s results', async (kind) => {
    const events: number[] = []
    const run = latestQueued((value: number, _context: TaskContext) => {
      events.push(value)
      if (kind === 'value')
        return value
      if (kind === 'promise')
        return Promise.resolve(value)
      const thenable: PromiseLike<number> = {
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
      }
      return thenable
    })
    const a = run(1)
    const b = run(2)
    const c = run(3)
    expect(events).toEqual([1])
    expect(b).toBe(c)
    await expect(Promise.all([a, b, c])).resolves.toEqual([1, 3, 3])
    expect(events).toEqual([1, 3])
    const d = run(4)
    expect(events).toEqual([1, 3, 4])
    await expect(d).resolves.toBe(4)
  })

  it('keeps only the last call from a large pending burst', async () => {
    const task = setup()
    const a = task.run('A')
    const callers = Array.from({ length: 20_000 }, (_, index) => task.run(String(index)))
    expect(new Set(callers).size).toBe(1)
    expect(task.signals.size).toBe(1)
    expect(task.events).toEqual(['start A'])
    task.gate('A').resolve('A')
    await a
    expect(task.events).toEqual(['start A', 'finish A', 'start 19999'])
    task.gate('19999').resolve('newest')
    const results = await Promise.all(callers)
    expect(results).toHaveLength(20_000)
    expect(results.every(value => value === 'newest')).toBe(true)
    expect(task.events).toEqual(['start A', 'finish A', 'start 19999', 'finish 19999'])
  })

  it('replaces pending calls added by a result handler', async () => {
    const task = setup()
    const a = task.run('A')
    const b = task.run('B')
    const done = a.then(() => task.run('C'))
    task.gate('A').resolve('A')
    await a
    expect(task.events.at(-1)).toBe('start B')
    const d = task.run('D')
    task.gate('B').resolve('B')
    await expect(b).resolves.toBe('B')
    expect(task.events.at(-1)).toBe('start D')
    task.gate('D').resolve('D')
    await expect(done).resolves.toBe('D')
    await expect(d).resolves.toBe('D')
    expect(task.maximum()).toBe(1)
  })

  it('creates no unhandled rejections when active and pending errors are handled', async () => {
    const errors: unknown[] = []
    const onUnhandled = (error: unknown) => {
      errors.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const error = new Error('failed')
      const run = latestQueued(() => Promise.reject(error))
      const a = run()
      const b = run()
      expect(run()).toBe(b)
      await Promise.all([expect(a).rejects.toBe(error), expect(b).rejects.toBe(error)])
      // Let Node report unhandled rejections before checking.
      await nextTurn()
      expect(errors).toEqual([])
    }
    finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps instances independent', async () => {
    const first = setup()
    const second = setup()
    const a = first.run('A')
    const b = second.run('B')
    expect(first.events).toEqual(['start A'])
    expect(second.events).toEqual(['start B'])
    first.gate('A').resolve('A')
    second.gate('B').resolve('B')
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
  })
})
