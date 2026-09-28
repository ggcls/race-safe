import type { TaskContext } from '../src/index'
import { describe, expect, it } from 'vitest'
import { latest } from '../src/index'
import { deferred } from './helpers/deferred'

const setup = () => {
  const signals = new Map<string, AbortSignal>()
  const tasks = new Map<string, ReturnType<typeof deferred<string>>>()
  const started: string[] = []
  const run = latest((name: string, { signal }: TaskContext) => {
    const task = deferred<string>()
    signals.set(name, signal)
    tasks.set(name, task)
    started.push(name)
    return task.promise
  })

  return {
    run,
    started,
    task: (name: string) => tasks.get(name)!,
    signal: (name: string) => signals.get(name)!,
  }
}

describe('latest', () => {
  it('passes arguments, injects a signal, and returns the result', async () => {
    const result = { items: ['typescript'] }
    const run = latest(async (query: string, page: number, { signal }: TaskContext) => {
      expect(query).toBe('typescript')
      expect(page).toBe(2)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
      return result
    })
    await expect(run('typescript', 2)).resolves.toBe(result)
  })

  it('starts B immediately and aborts A while B remains active', async () => {
    const { run, task, signal, started } = setup()
    const a = run('A')
    const b = run('B')
    expect(started).toEqual(['A', 'B'])
    expect(signal('A').aborted).toBe(true)
    expect(signal('A').reason).toBeInstanceOf(DOMException)
    expect(signal('A').reason.name).toBe('AbortError')
    expect(signal('B').aborted).toBe(false)
    task('B').resolve('B result')
    await expect(b).resolves.toBe('B result')
    task('A').resolve('A result')
    await expect(a).resolves.toBe('A result')
    expect(signal('B').aborted).toBe(false)
  })

  it('keeps B active after A resolves', async () => {
    const { run, task, signal } = setup()
    const a = run('A')
    const b = run('B')
    task('A').resolve('A result')
    await expect(a).resolves.toBe('A result')
    expect(signal('B').aborted).toBe(false)
    const c = run('C')
    expect(signal('B').aborted).toBe(true)
    expect(signal('C').aborted).toBe(false)
    task('B').resolve('B result')
    await expect(b).resolves.toBe('B result')
    task('C').resolve('C result')
    await expect(c).resolves.toBe('C result')
  })

  it('delivers A then B when they finish in invocation order', async () => {
    const { run, task, signal } = setup()
    const a = run('A')
    const b = run('B')
    task('A').resolve('A result')
    await expect(a).resolves.toBe('A result')
    expect(signal('B').aborted).toBe(false)
    task('B').resolve('B result')
    await expect(b).resolves.toBe('B result')
  })

  it('propagates rejection unchanged and recovers on the next call', async () => {
    const { run, task, signal } = setup()
    const error = new Error('failed')
    const a = run('A')
    const rejected = expect(a).rejects.toBe(error)
    task('A').reject(error)
    await rejected
    const b = run('B')
    expect(signal('A').aborted).toBe(false)
    task('B').resolve('recovered')
    await expect(b).resolves.toBe('recovered')
  })

  it('keeps B active after A rejects', async () => {
    const { run, task, signal } = setup()
    const error = { reason: 'arbitrary thrown value' }
    const a = run('A')
    const rejected = expect(a).rejects.toBe(error)
    const b = run('B')
    task('A').reject(error)
    await rejected
    const c = run('C')
    expect(signal('B').aborted).toBe(true)
    task('B').resolve('B')
    task('C').resolve('C')
    await expect(b).resolves.toBe('B')
    await expect(c).resolves.toBe('C')
  })

  it('rejects on a synchronous throw and clears the active call', async () => {
    const error = new Error('synchronous failure')
    const signals: AbortSignal[] = []
    const run = latest((fail: boolean, { signal }: TaskContext) => {
      signals.push(signal)
      if (fail)
        throw error
      return 42
    })
    let failed!: Promise<number>
    expect(() => {
      failed = run(true)
    }).not.toThrow()
    await expect(failed).rejects.toBe(error)
    await expect(run(false)).resolves.toBe(42)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
  })

  it('preserves AbortError from an operation that honors the signal', async () => {
    const error = new DOMException('Request cancelled', 'AbortError')
    const completion = deferred<string>()
    const run = latest((name: string, { signal }: TaskContext) => {
      if (name === 'B')
        return completion.promise
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(error), { once: true })
      })
    })
    const a = run('A')
    const rejected = expect(a).rejects.toBe(error)
    const b = run('B')
    await rejected
    completion.resolve('B')
    await expect(b).resolves.toBe('B')
  })

  it('clears the active call after an immediately resolved Promise', async () => {
    const signals: AbortSignal[] = []
    const run = latest(({ signal }: TaskContext) => {
      signals.push(signal)
      return Promise.resolve(42)
    })
    await expect(run()).resolves.toBe(42)
    await expect(run()).resolves.toBe(42)
    expect(signals.every(signal => !signal.aborted)).toBe(true)
  })

  it('handles immediately rejected promises without detached rejections', async () => {
    const error = new Error('immediate rejection')
    const run = latest((fail: boolean, _context: TaskContext) => {
      return fail ? Promise.reject(error) : Promise.resolve('recovered')
    })
    await expect(run(true)).rejects.toBe(error)
    await expect(run(false)).resolves.toBe('recovered')
  })

  it('keeps a reentrant call active when the outer call throws', async () => {
    const error = new Error('outer failure')
    const completion = deferred<string>()
    const signals = new Map<string, AbortSignal>()
    let b!: Promise<string>
    const run: (name: string) => Promise<string> = latest((name: string, { signal }: TaskContext) => {
      signals.set(name, signal)
      if (name === 'A') {
        b = run('B')
        throw error
      }
      return completion.promise
    })
    await expect(run('A')).rejects.toBe(error)
    const c = run('C')
    expect(signals.get('B')!.aborted).toBe(true)
    expect(signals.get('C')!.aborted).toBe(false)
    completion.resolve('done')
    await Promise.all([b, c])
  })

  it('handles reentrant calls from the wrapped function', async () => {
    const signals = new Map<string, AbortSignal>()
    const completion = deferred<string>()
    let b!: Promise<string>
    const run: (name: string) => Promise<string> = latest((name: string, { signal }: TaskContext) => {
      signals.set(name, signal)
      if (name === 'A') {
        b = run('B')
        return 'A'
      }
      return completion.promise
    })
    await expect(run('A')).resolves.toBe('A')
    expect(signals.get('A')!.aborted).toBe(true)
    expect(signals.get('B')!.aborted).toBe(false)
    const c = run('C')
    expect(signals.get('B')!.aborted).toBe(true)
    completion.resolve('done')
    await Promise.all([b, c])
  })

  it('keeps calls from abort listeners current', async () => {
    const signals = new Map<string, AbortSignal>()
    const started: string[] = []
    const completion = deferred<string>()
    let c!: Promise<string>
    const run: (name: string) => Promise<string> = latest((name: string, { signal }: TaskContext) => {
      signals.set(name, signal)
      started.push(name)
      if (name === 'A')
        signal.addEventListener('abort', () => { c = run('C') }, { once: true })
      return completion.promise
    })
    const a = run('A')
    const b = run('B')
    expect(started).toEqual(['A', 'C', 'B'])
    expect(signals.get('A')!.aborted).toBe(true)
    expect(signals.get('B')!.aborted).toBe(true)
    expect(signals.get('C')!.aborted).toBe(false)
    const d = run('D')
    expect(signals.get('C')!.aborted).toBe(true)
    expect(signals.get('D')!.aborted).toBe(false)
    completion.resolve('done')
    await Promise.all([a, b, c, d])
  })

  it('keeps separate wrappers independent', async () => {
    const first = setup()
    const second = setup()
    const a = first.run('A')
    const b = second.run('B')
    const c = first.run('C')
    expect(first.signal('A').aborted).toBe(true)
    expect(second.signal('B').aborted).toBe(false)
    first.task('A').resolve('A')
    second.task('B').resolve('B')
    first.task('C').resolve('C')
    await Promise.all([a, b, c])
  })
})
