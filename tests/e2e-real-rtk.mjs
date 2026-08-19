/**
 * End-to-end smoke test against a REAL rtk binary in pipe mode.
 * Skips itself when no rtk can be resolved (kept in the suite for machines
 * that have rtk installed, e.g. via Homebrew or Cargo).
 *
 * Real-rtk note: `rtk pipe` only condenses when the input matches the
 * configured filter (e.g. `-f cargo-test`); unmatched input passes through
 * unchanged, and the plugin then deliberately adds nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as RtkFilter from '../lib/index.js'

test('real rtk (pipe -f cargo-test) condenses oversized bash output and preserves markers', async () => {
  const resolved = RtkFilter.resolveRtkPath('rtk')
  if (resolved === 'rtk') {
    console.log('rtk not found on this machine; skipping real-binary e2e')
    return
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Bare command name on purpose: exercises the candidate-dir fallback.
  await ctx.plugin(RtkFilter, { command: 'rtk', args: ['pipe', '-f', 'cargo-test'], minBytes: 0 })

  // cargo-test style output: many passing lines, one failure block.
  const okLines = Array.from({ length: 30 }, (_, i) => `test math::case${i} ... ok`).join('\n')
  const rendered = [
    'running 31 tests',
    okLines,
    'test math::sub ... FAILED',
    '',
    'failures:',
    '',
    '---- math::sub stdout ----',
    'thread main panicked at src/lib.rs:42:5',
    '',
    'failures:',
    '    math::sub',
    'test result: FAILED. 30 passed; 1 failed',
    '[exit code: 101]',
  ].join('\n')
  ctx.tools.register(defineContentToolFixture({
    name: 'bash', description: 'bash', parameters: {},
    async execute() { return [{ type: 'text', text: rendered }] },
  }))
  const result = await ctx.tools.execute({ callId: 'call-e2e', name: 'bash', arguments: {}, signal: new AbortController().signal })
  assert.equal(result.isError, false)
  const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.ok(text.includes('[exit code: 101]'), 'exit marker preserved')
  assert.ok(/\[rtk: output condensed/.test(text), 'notice present when rtk actually condensed')
  assert.ok(text.includes('test result: FAILED'), 'failure summary survives')
  // The 30 passing lines collapse into a compact summary — the whole point.
  assert.ok(text.length < rendered.length, 'model-facing text is smaller than the raw output')
})