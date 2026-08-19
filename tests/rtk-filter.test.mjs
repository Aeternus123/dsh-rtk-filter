/**
 * Tests for the dsh-rtk-filter plugin: a `tools/post-execute` transformer
 * that pipes oversized command output through the `rtk` CLI. We drive real
 * tools through `ctx.tools.execute(...)` and assert: disabled mode is a true
 * no-op, oversized bash/job_output results are condensed with their trailing
 * status markers preserved, small/non-listed results pass through, and every
 * rtk failure (missing binary, non-zero exit, timeout, no change) keeps the
 * original result without an `isError`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as RtkFilter from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const STUB = join(here, 'bin', 'rtk')

/** A tool returning `text` verbatim (name configurable so we can register bash/job_output/others). */
function textTool(name, text) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() {
      return [{ type: 'text', text }]
    },
  })
}

/** A minimal execution input; the plugin reads only name/signal/callId. */
function exec(name) {
  return {
    callId: `call-${name}`,
    name,
    arguments: {},
    signal: new AbortController().signal,
  }
}

/** Build a context with tools + the plugin; the stub rtk is the default command. */
async function setup(config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(RtkFilter, { command: STUB, minBytes: 0, ...config })
  return ctx
}

/** Flatten a result's text blocks. */
function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

/** Many distinct lines so the stub rtk has something to condense. */
function bigBody(lineCount = 60) {
  return Array.from({ length: lineCount }, (_, i) => `output line ${i} of ${lineCount}`).join('\n')
}

test('loader export shape: name/inject/Config/apply present, no default export', () => {
  assert.equal(RtkFilter.name, 'rtk-filter')
  assert.deepEqual(RtkFilter.inject, ['tools'])
  assert.equal(typeof RtkFilter.apply, 'function')
  assert.ok(RtkFilter.Config)
  assert.equal('default' in RtkFilter, false)
})

test('disabled mode is a true no-op', async () => {
  const ctx = await setup({ enabled: false })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(result.isError, false)
  assert.equal(textOf(result.content), body)
})

test('condenses an oversized bash result and preserves trailing status markers', async () => {
  const ctx = await setup()
  const body = bigBody()
  const rendered = `${body}\n[exit code: 3]\n[killed by signal: SIGTERM]`
  ctx.tools.register(textTool('bash', rendered))
  const result = await ctx.tools.execute(exec('bash'))

  assert.equal(result.isError, false)
  const text = textOf(result.content)
  // The condensed body comes first (stub rtk keeps the first 20 lines).
  assert.ok(text.startsWith('output line 0 of 60'), 'condensed body should lead')
  assert.ok(text.includes('[stub rtk: condensed 60 lines to 20]'), 'stub condensation summary should appear')
  // The raw middle lines are gone.
  assert.ok(!text.includes('output line 30 of 60'), 'raw middle lines must not reach the model')
  // Markers survive, in order, after a notice line.
  const markerIdx = text.indexOf('[exit code: 3]')
  const signalIdx = text.indexOf('[killed by signal: SIGTERM]')
  const noticeIdx = text.indexOf('[rtk: output condensed')
  assert.ok(markerIdx > -1 && signalIdx > markerIdx, 'status markers preserved in order')
  assert.ok(noticeIdx > -1 && noticeIdx < markerIdx, 'notice precedes the preserved markers')
})

test('job_output results are condensed and keep their status line', async () => {
  const ctx = await setup()
  const body = bigBody()
  const rendered = `${body}\n[status: completed]`
  ctx.tools.register(textTool('job_output', rendered))
  const result = await ctx.tools.execute(exec('job_output'))
  const text = textOf(result.content)
  assert.ok(text.startsWith('output line 0 of 60'))
  assert.ok(text.endsWith('[status: completed]'))
  assert.ok(text.includes('[rtk: output condensed'))
})

test('small outputs pass through untouched (minBytes gate)', async () => {
  const ctx = await setup({ minBytes: 100_000 })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(textOf(result.content), body)
})

test('tools outside the filter list are untouched', async () => {
  const ctx = await setup()
  const body = bigBody()
  ctx.tools.register(textTool('grep', body))
  const result = await ctx.tools.execute(exec('grep'))
  assert.equal(textOf(result.content), body)
})

test('a bare command missing from PATH and every candidate dir keeps the original result', async () => {
  const ctx = await setup({ command: 'rtk-not-installed-anywhere' })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(result.isError, false)
  assert.equal(textOf(result.content), body)
})

test('a non-zero rtk exit keeps the original result', async () => {
  const ctx = await setup({ args: ['--fail'] })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(result.isError, false)
  assert.equal(textOf(result.content), body)
})

test('an rtk timeout keeps the original result', async () => {
  const ctx = await setup({ args: ['--sleep'], timeoutMs: 300 })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(result.isError, false)
  assert.equal(textOf(result.content), body)
})

test('an RTK response identical to the input adds no notice noise', async () => {
  const ctx = await setup({ args: ['--echo'] })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(textOf(result.content), body)
})

test('value-replacement decisions pass through untouched', async () => {
  const ctx = await setup()
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  // A downstream listener (registered after the plugin, so it runs inside the
  // plugin's next()) replaces the value; the plugin must not re-shape it.
  const replacement = [{ type: 'text', text: 'replacement' }]
  ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: replacement }))
  const result = await ctx.tools.execute(exec('bash'))
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, replacement)
})

test('caller cancellation kills the rtk process group and settles promptly', async () => {
  const controller = new AbortController()
  const ctx = await setup({ args: ['--sleep'], timeoutMs: 10_000 })
  const body = bigBody()
  ctx.tools.register(textTool('bash', body))
  // Cancel shortly after dispatch begins. The plugin must kill rtk (and its
  // process group) immediately instead of waiting for the sleep to finish —
  // a fix that held the pipes open would turn this into a 30s test.
  const timer = setTimeout(() => controller.abort(), 150)
  const result = await ctx.tools.execute(execWithSignal('bash', controller.signal))
  clearTimeout(timer)
  // Caller cancellation is harness semantics: the registry replaces the
  // successful outcome with an ABORTED error result.
  assert.equal(result.isError, true)
  assert.equal(result.error?.info?.code, 'ABORTED')
})

/** exec with a caller-owned signal. */
function execWithSignal(name, signal) {
  return { callId: `call-${name}`, name, arguments: {}, signal }
}

test('pure: splitTrailingMarkers splits body from markers', () => {
  const { body, markers } = RtkFilter.splitTrailingMarkers('a\nb\n\n[exit code: 0]')
  assert.equal(body, 'a\nb')
  assert.deepEqual(markers, ['[exit code: 0]'])

  const multi = RtkFilter.splitTrailingMarkers('x\n[exit code: 1]\n[killed by signal: SIGTERM]')
  assert.equal(multi.body, 'x')
  assert.deepEqual(multi.markers, ['[exit code: 1]', '[killed by signal: SIGTERM]'])

  const none = RtkFilter.splitTrailingMarkers('plain text only')
  assert.equal(none.body, 'plain text only')
  assert.deepEqual(none.markers, [])

  // A marker-looking line that is mid-text stays in the body.
  const mid = RtkFilter.splitTrailingMarkers('[exit code: 9]\nstill output\n[status: completed]')
  assert.equal(mid.body, '[exit code: 9]\nstill output')
  assert.deepEqual(mid.markers, ['[status: completed]'])
})

test('pure: flattenPlainText rejects non-text blocks', () => {
  assert.equal(RtkFilter.flattenPlainText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(RtkFilter.flattenPlainText([{ type: 'image', data: {} }]), undefined)
})

test('pure: runRtk returns the condensed stdout', async () => {
  const out = await RtkFilter.runRtk(STUB, [], 'one\ntwo\nthree', undefined, 5000)
  assert.equal(out.text, 'one\ntwo\nthree\n')
  assert.equal(out.failure, undefined)
})

test('pure: runRtk reports a missing binary without rejecting', async () => {
  const out = await RtkFilter.runRtk('/nonexistent/rtk-binary', [], 'x', undefined, 5000)
  assert.equal(out.text, undefined)
  assert.ok(out.failure)
})

test('pure: resolveRtkPath keeps explicit paths and probes candidate dirs', () => {
  // Explicit paths are returned verbatim (no probing).
  assert.equal(RtkFilter.resolveRtkPath('/opt/homebrew/bin/rtk'), '/opt/homebrew/bin/rtk')
  // A bare name found in a candidate dir resolves to that absolute path.
  const testBin = join(here, 'bin')
  assert.equal(RtkFilter.resolveRtkPath('rtk', [testBin]), join(testBin, 'rtk'))
  // A bare name in no candidate dir is returned unchanged (spawn reports ENOENT).
  assert.equal(RtkFilter.resolveRtkPath('rtk-not-installed-anywhere', [testBin]), 'rtk-not-installed-anywhere')
  // The default candidate list includes the Homebrew and Rustup dirs the
  // minimal harness PATH misses.
  assert.ok(RtkFilter.DEFAULT_RTK_CANDIDATE_DIRS.includes('/opt/homebrew/bin'))
  assert.ok(RtkFilter.DEFAULT_RTK_CANDIDATE_DIRS.includes('~/.cargo/bin'))
})

test('pure: buildCondensedBody composes body + notice + markers', () => {
  const text = RtkFilter.buildCondensedBody('condensed', ['[exit code: 1]'], 100, 10, true)
  assert.equal(text, 'condensed\n\n[rtk: output condensed 100 → 10 bytes]\n\n[exit code: 1]')
  const bare = RtkFilter.buildCondensedBody('condensed', [], 100, 10, false)
  assert.equal(bare, 'condensed')
})
