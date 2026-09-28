import { expect, it } from 'vitest'
import * as raceSafe from '../src/index'

it('exports only the implemented strategies', () => {
  expect(Object.keys(raceSafe).sort()).toEqual(['drop', 'latest', 'latestQueued', 'queue'])
  expect(raceSafe.drop).toBeTypeOf('function')
  expect(raceSafe.latest).toBeTypeOf('function')
  expect(raceSafe.latestQueued).toBeTypeOf('function')
  expect(raceSafe.queue).toBeTypeOf('function')
})

it('exposes no task controls or state properties on wrapped functions', () => {
  for (const run of [
    raceSafe.latest(() => 42),
    raceSafe.drop(() => 42),
    raceSafe.queue(() => 42),
    raceSafe.latestQueued(() => 42),
  ]) {
    expect(Object.getOwnPropertyNames(run).sort()).toEqual(['length', 'name'])
    expect(Object.getOwnPropertySymbols(run)).toEqual([])
  }
})
