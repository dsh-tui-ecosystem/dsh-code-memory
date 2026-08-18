import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerMemoryEventTypes } from '../src/registration.js'

/**
 * Reproduces the real-world resume failure: the CLI tree owns the validator's
 * dsh-session copy, the global bin is a symlink shim (so raw argv[1] resolves
 * nothing), and the plugin's own anchor resolves a different copy entirely.
 * Registration must still reach the CLI copy via realpath(argv[1]).
 */
let root: string
let cliSessionDir: string
let shim: string
let originalArgv1: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-reg-'))
  cliSessionDir = join(root, 'cli', 'node_modules', '@deepseek-ai', 'dsh-session')
  mkdirSync(join(cliSessionDir, 'lib'), { recursive: true })
  writeFileSync(join(cliSessionDir, 'lib', 'index.js'), [
    "'use strict'",
    'const KNOWN_SESSION_EVENT_TYPES = new Set([\'user/message\'])',
    'module.exports = { KNOWN_SESSION_EVENT_TYPES }',
    '',
  ].join('\n'))
  writeFileSync(join(cliSessionDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.0', main: 'lib/index.js' }))
  const bin = join(root, 'cli', 'lib', 'bin.js')
  mkdirSync(join(bin, '..'), { recursive: true })
  writeFileSync(bin, '#!/usr/bin/env node\n')
  shim = join(root, 'bin', 'dsh')
  mkdirSync(join(shim, '..'), { recursive: true })
  symlinkSync(bin, shim)
  originalArgv1 = process.argv[1]
  process.argv[1] = shim
})

afterEach(() => {
  if (originalArgv1 === undefined) delete process.argv[1]
  else process.argv[1] = originalArgv1
  rmSync(root, { recursive: true, force: true })
})

function cliSet(): Set<string> {
  // Read back through require: proves the mutation lands in the module the
  // process would load, not a detached copy.
  const { createRequire } = require('node:module')
  return createRequire(join(cliSessionDir, 'noop.js'))('@deepseek-ai/dsh-session').KNOWN_SESSION_EVENT_TYPES
}

describe('registerMemoryEventTypes', () => {
  it('reaches the CLI copy through a symlinked bin shim (realpath anchor)', () => {
    registerMemoryEventTypes()
    const set = cliSet()
    expect(set.has('memory/recalled')).toBe(true)
    expect(set.has('memory/captured')).toBe(true)
    expect(set.has('memory/recall-used')).toBe(true)
    expect(set.has('memory/superseded')).toBe(true)
  })

  it('is idempotent and tolerates unresolvable anchors', () => {
    registerMemoryEventTypes()
    registerMemoryEventTypes() // no throw, no growth beyond the 4 types
    const set = cliSet()
    expect([...set].filter((type) => type.startsWith('memory/')).sort()).toEqual([
      'memory/captured',
      'memory/recall-used',
      'memory/recalled',
      'memory/superseded',
    ])
  })

  it('registers into extra anchors (e.g. a second harness tree)', () => {
    const otherDir = join(root, 'other', 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(join(otherDir, 'lib'), { recursive: true })
    writeFileSync(join(otherDir, 'lib', 'index.js'), [
      "'use strict'",
      'module.exports = { KNOWN_SESSION_EVENT_TYPES: new Set() }',
      '',
    ].join('\n'))
    writeFileSync(join(otherDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.0', main: 'lib/index.js' }))
    registerMemoryEventTypes([join(otherDir, 'noop.js')])
    const { createRequire } = require('node:module')
    const otherSet = createRequire(join(otherDir, 'noop.js'))('@deepseek-ai/dsh-session').KNOWN_SESSION_EVENT_TYPES
    expect(otherSet.has('memory/recalled')).toBe(true)
  })
})
