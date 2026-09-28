# 🏁 race-safe

> Tiny concurrency strategies for async JavaScript functions.

Control what happens when an async function is called again before its previous invocation finishes.
Four small wrappers, with TypeScript inference, Web-standard cancellation, and no runtime dependencies.

## Install

```sh
# npm
npm install @ggcls/race-safe

# pnpm
pnpm add @ggcls/race-safe
```

## Usage

Import a strategy and wrap your function.
It receives your arguments followed by an injected `TaskContext`; callers only pass the original arguments.

```ts
import type { TaskContext } from '@ggcls/race-safe'
import { latest } from '@ggcls/race-safe'

const search = latest(async (query: string, { signal }: TaskContext) => {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal })
  if (!response.ok) throw new Error(`Search failed: ${response.status}`)
  return response.text()
})

const results = await search('typescript') // string
```

### Choose a strategy

Each wrapper manages its own invocations independently.

| Strategy                          | When another call arrives                                   | Use case                  |
| --------------------------------- | ----------------------------------------------------------- | ------------------------- |
| [`latest`](#latestfn)             | Abort the previous signal and start immediately.            | Search, autocomplete      |
| [`drop`](#dropfn)                 | Discard the new call and share the active Promise.          | Repeated form submissions |
| [`queue`](#queuefn)               | Keep every call and execute in order.                       | Ordered writes            |
| [`latestQueued`](#latestqueuedfn) | Keep running; replace the pending call with the newest one. | Autosave full snapshots   |

## API

### `latest(fn)`

Start each invocation immediately and abort the previous active invocation's signal.

```text
A ─────X · · · ·
   B ─────X · · ·
      C ─────────►

X = signal aborted; work that ignores it may continue
```

Each call receives its own Promise for its own execution.
A newer call does not settle an older call's Promise: if the operation stops with an `AbortError`, that error reaches its caller unchanged.
If it ignores the signal, its eventual value or error still reaches its caller.

For autocomplete, pass the signal to `fetch` and check it before updating the UI:

```ts
import type { TaskContext } from '@ggcls/race-safe'
import { latest } from '@ggcls/race-safe'

const input = document.querySelector<HTMLInputElement>('#search')!
const suggestions = document.querySelector<HTMLElement>('#suggestions')!

const search = latest(async (query: string, { signal }: TaskContext) => {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal })
  if (!response.ok) throw new Error(`Search failed: ${response.status}`)

  const text = await response.text()
  if (!signal.aborted) suggestions.textContent = text
})

input.addEventListener('input', () => {
  search(input.value).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    console.error('Search failed', error)
  })
})
```

### `drop(fn)`

Run one invocation at a time and discard calls that arrive while it is active.

```text
A ─────────────►
   B ✕
      C ✕
```

A, B, and C receive the **same Promise object**, resolving with A's value or rejecting with A's original error.
B and C's arguments are discarded; those calls never execute later.
Sharing the Promise lets repeated callers observe the ongoing action without a sentinel return value or an error just for overlapping.

Dropped calls do not abort the active signal. After success or failure, a new call can execute normally.

```ts
import type { TaskContext } from '@ggcls/race-safe'
import { drop } from '@ggcls/race-safe'

const form = document.querySelector<HTMLFormElement>('#profile')!
const status = document.querySelector<HTMLElement>('#save-status')!

const submit = drop(async (data: FormData, { signal }: TaskContext) => {
  const response = await fetch('/api/profile', {
    method: 'POST',
    body: data,
    signal,
  })
  if (!response.ok) throw new Error(`Save failed: ${response.status}`)

  // Keep this inside the wrapper so it runs once per executed submission.
  status.textContent = 'Profile saved'
  return response.status
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  submit(new FormData(form)).catch((error: unknown) => {
    status.textContent = 'Could not save profile'
    console.error(error)
  })
})
```

`drop` is not debounce, throttle, queueing, or deduplication by argument.
It only controls overlapping executions of one wrapper; different arguments still share the active result.
It adds no delay and remembers no completed results.

### `queue(fn)`

Preserve every invocation and execute them one at a time in call order.

```text
A ─────►
        B ─────►
                C ─────►
```

Each call receives a distinct Promise for its own execution.
A rejection or synchronous throw affects only that caller; subsequent calls still run.
New calls do not abort active work.

Use `queue` when every write must be sent, even if an earlier write fails:

```ts
import type { TaskContext } from '@ggcls/race-safe'
import { queue } from '@ggcls/race-safe'

const updateProfile = queue(
  async (patch: { displayName?: string; bio?: string }, { signal }: TaskContext) => {
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal,
    })
    if (!response.ok) throw new Error(`Profile update failed: ${response.status}`)
    return response.status
  },
)

const results = await Promise.allSettled([
  updateProfile({ displayName: 'Ada' }),
  updateProfile({ bio: 'Building small tools' }),
])

for (const result of results) {
  if (result.status === 'rejected') console.error('Profile update failed', result.reason)
}
```

### `latestQueued(fn)`

Let the active invocation finish and keep only the newest pending invocation.

```text
A ─────────────►
   B pending
      C replaces B
         D replaces C
                 D ─────►
```

Only A and D execute. A has its own Promise.
B, C, and D share the **same pending Promise**, which resolves with D's value or rejects with D's original error.
Replacing a pending call does not settle that Promise early.

Once D starts, further calls create or replace a new pending slot with a different Promise.
A failure in the active invocation does not prevent pending work from starting.
Neither queuing nor replacement aborts the active signal.

Use this for full snapshots where a newer state can replace an unsent one:

```ts
import type { TaskContext } from '@ggcls/race-safe'
import { latestQueued } from '@ggcls/race-safe'

const editor = document.querySelector<HTMLTextAreaElement>('#draft')!

const saveDraft = latestQueued(async (draft: string, { signal }: TaskContext) => {
  const response = await fetch('/api/draft', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: draft }),
    signal,
  })
  if (!response.ok) throw new Error(`Autosave failed: ${response.status}`)
  return response.status
})

editor.addEventListener('input', () => {
  saveDraft(editor.value).catch((error: unknown) => {
    console.error('Autosave failed', error)
  })
})
```

Use `queue` instead when every individual edit must be preserved.
`latestQueued` adds no debounce window: it starts immediately when idle and runs the pending invocation as soon as active work settles.

### `TaskContext`

The only exported type.
Each execution receives a fresh context:

```ts
interface TaskContext {
  signal: AbortSignal
}
```

Annotate the wrapped function's final parameter as `TaskContext` to infer the
preceding arguments.
Dropped or replaced calls that never execute receive no context or signal.

## Promise behavior

All wrappers accept synchronous values, Promises, and Promise-like thenables.
They always return `Promise<Awaited<T>>`.
User errors, including synchronous throws and non-`Error` values, become rejections with the original reason.

| Strategy       | Promise returned to an overlapping caller              |
| -------------- | ------------------------------------------------------ |
| `latest`       | Its own execution's Promise, even if later superseded. |
| `drop`         | The exact active Promise.                              |
| `queue`        | Its own queued execution's Promise.                    |
| `latestQueued` | The exact pending Promise, shared across replacements. |

With shared Promises, the result may come from an execution with different arguments.
Every attached handler still runs; put effects that should happen once inside the wrapped function. Handle rejections as with any async API.

### Execution timing

- The first invocation starts during the wrapper call. No timers are introduced.
- Synchronous return values and fulfilled Promises still settle through microtasks, so an immediate second call can overlap.
- A synchronous throw releases the active state before returning a rejected Promise. Pending work can then start.
- Cleanup happens before callers' settlement handlers run. Pending work may already be running by then.

Do not await or return a reentrant call from an active `drop`, `queue`, or `latestQueued` invocation: that call depends on the active invocation finishing.
A hung execution also keeps `drop` busy and blocks pending work in the other two.

Arguments are passed by reference, not cloned.
Pass snapshots if later mutations would change queued input.
Bind methods that depend on `this` before wrapping them.

### Generic callbacks

Ordinary callbacks retain their argument and resolved return types without manual generics.
`latest` and `queue` can also preserve generic input/output relationships because each caller receives its own result.

`drop` and `latestQueued` widen generic results to cover every value that may be shared.
An unconstrained generic callback therefore returns `Promise<unknown>`:

```ts
import type { TaskContext } from '@ggcls/race-safe'
import { drop } from '@ggcls/race-safe'

const echo = <T>(value: T, _context: TaskContext): T => value
const run = drop(echo)

const first = run(123) // Promise<unknown>
const second = run('abc') // Same Promise; resolves to 123.

const textOnly = drop((value: string, context: TaskContext) => echo(value, context))
const text = await textOnly('hello') // string
```

Use a concrete adapter for overloaded callbacks too; wrappers do not preserve an overload set.

## Cancellation

Only `latest` aborts an internal signal.
It uses `AbortController.abort()` with the runtime's default `AbortError` reason.
Aborting requests cancellation; it does not settle the wrapper's Promise by itself.

An obsolete invocation is no longer tracked as current.
That does **not** mean its underlying work has stopped.
Operations such as `fetch` observe the signal, but arbitrary JavaScript cannot be forcibly interrupted.
Results are not suppressed, and side effects cannot be undone.
Check `signal.aborted` before committing UI updates that could be stale.

Reentrant calls also supersede the current `latest` invocation.
If an abort listener starts another call, an intervening invocation can enter its function with an already-aborted signal.

`drop`, `queue`, and `latestQueued` leave active work running.
There are no `.cancel()` or `.pending` controls, external signal options, or keyed strategies.

## Runtime support

ESM only, targeting ES2022, with TypeScript declarations and tree-shakeable exports.
The core uses Web-standard APIs and has no Node.js imports or runtime dependencies.

Intended targets are modern browsers, Node.js 22+, Bun, Deno, and Cloudflare Workers with `Promise`, `queueMicrotask`, `AbortController`, `AbortSignal`, and `DOMException`.
The library is currently checked on Node.js 24; validation across other runtimes is still pending.
No CommonJS build or polyfills are provided.

## Development

Clone the repository, install Node.js 24 and pnpm 11.24.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm check
```

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `pnpm dev`           | Run tests in watch mode.                 |
| `pnpm test`          | Run unit tests and TypeScript checks.    |
| `pnpm test:coverage` | Run unit tests with coverage.            |
| `pnpm lint`          | Check code and formatting.               |
| `pnpm build`         | Build the ESM package and declarations.  |
| `pnpm check`         | Run lint, tests, type checks, and build. |
| `pnpm pack`          | Build and create a package tarball.      |

Source lives in `src/` and tests in `test/`.
Concurrency tests use controllable Promises to check execution order and cleanup without arbitrary timer delays.

## License

Published under the [MIT License](./LICENSE).
