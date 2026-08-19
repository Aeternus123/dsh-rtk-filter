/**
 * dsh-rtk-filter — condense command output with the external `rtk` CLI.
 *
 * A `tools/post-execute` result transformer, the harness's documented
 * extension point for shaping what a tool call returns to the model: the
 * waterfall runs after dispatch and immediately before lossless
 * materialization, and a listener may `accept` a replacement `content`
 * projection. This plugin pipes oversized plain-text results of the
 * configured tools (default: `bash` and `job_output` — foreground and
 * background command output) through `rtk` and hands the model RTK's
 * condensed output instead of the raw text.
 *
 * ## What is preserved
 *
 * - Trailing harness status markers (`[exit code: N]`, `[killed by signal: …]`,
 *   `[timed out after Nms]`, `[sandbox: …]`, `[status: …]`) are split off
 *   BEFORE rtk runs and re-appended after the condensed body, so the
 *   agent loop's exit-status contract survives condensation.
 * - Outputs smaller than `minBytes` never touch rtk (no per-command latency).
 * - The tool's canonical `value` is never touched: only the model-facing
 *   text projection is replaced.
 *
 * ## Best-effort degradation
 *
 * A missing rtk binary, a non-zero rtk exit, an rtk timeout, caller
 * cancellation, an empty RTK response, or an RTK response identical to the
 * input all keep the original result and never turn a successful call into
 * an `isError`. Failures are logged once each, not per call.
 *
 * @module dsh-rtk-filter
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
export const name = 'rtk-filter';
/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export const inject = ['tools'];
export const Config = z.object({
    enabled: z.boolean().default(true),
    command: z.string().default('rtk'),
    args: z.array(z.string()).default([]),
    tools: z.array(z.string()).default(['bash', 'job_output']),
    minBytes: z.number().step(1).min(0).default(2048),
    timeoutMs: z.number().step(1).min(1).default(15_000),
    notice: z.boolean().default(true),
});
/** All-text content flattened to one string, or `undefined` if any block is non-text. */
export function flattenPlainText(content) {
    let text = '';
    for (const block of content) {
        if (block.type !== 'text')
            return undefined;
        text += block.text;
    }
    return text;
}
/**
 * Extra directories probed when `command` is a bare name that is not on the
 * harness process PATH. The GUI/CLI is launched with a minimal environment
 * (Finder/launchd do not source the user's shell profile), so tools installed
 * by Homebrew (`/opt/homebrew/bin`) or Rustup (`~/.cargo/bin`) are invisible
 * to PATH resolution even though the user's terminal finds them.
 */
export const DEFAULT_RTK_CANDIDATE_DIRS = [
    '~/.cargo/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '~/.local/bin',
];
/** Resolve a candidate directory that may use a leading `~`. */
function expandCandidateDir(dir) {
    return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
}
/** Last successfully resolved absolute path, keyed by the command name. */
let resolvedPathCache;
/**
 * Resolve `command` to an executable path: an explicit path (containing a
 * separator) is returned verbatim; a bare name is looked up in the harness
 * PATH first and, failing that, in {@link DEFAULT_RTK_CANDIDATE_DIRS}.
 * Successes are cached; misses return the bare name so `spawn` reports the
 * usual ENOENT (the caller degrades to the original output).
 */
export function resolveRtkPath(command, candidateDirs = DEFAULT_RTK_CANDIDATE_DIRS) {
    if (command.includes('/'))
        return command;
    if (resolvedPathCache?.command === command)
        return resolvedPathCache.path;
    for (const dir of candidateDirs) {
        const candidate = join(expandCandidateDir(dir), command);
        if (existsSync(candidate)) {
            resolvedPathCache = { command, path: candidate };
            return candidate;
        }
    }
    return command;
}
/**
 * Known trailing status-marker lines emitted by the shell tool renderers
 * (`[exit code: N]`, `[killed by signal: S]`, `[timed out after Nms]`,
 * `[sandbox: …]`) and the jobs controller (`[status: …]`). The shell
 * renderers append their markers LAST and the jobs controller appends the
 * status line last too, so trailing lines matching these contracts are the
 * status block; everything before is the output to condense.
 */
const MARKER_LINE = /^\[(?:exit code: -?\d+|killed by signal: [^\]]+|timed out after \d+ms|sandbox: [^\]]+|status: [^\]]+)\]$/;
/**
 * Split a rendered tool result into its output body and its trailing status
 * markers. A line that merely LOOKS like a marker but is part of the body
 * (e.g. a command echoed `[exit code: 1]` as its last output) is
 * indistinguishable by text alone; the split is intentionally conservative —
 * only a consecutive run of marker lines at the very end is treated as the
 * status block.
 */
export function splitTrailingMarkers(text) {
    const lines = text.split('\n');
    const markers = [];
    let i = lines.length;
    // The renderer inserts a blank line before the marker block; skip trailing
    // empties that belong to that boundary.
    while (i > 0 && lines[i - 1] === '')
        i -= 1;
    while (i > 0 && MARKER_LINE.test(lines[i - 1] ?? '')) {
        markers.unshift(lines[i - 1]);
        i -= 1;
    }
    const body = lines.slice(0, i).join('\n').replace(/\s+$/, '');
    return { body, markers };
}
/** Upper bound on captured rtk stdout/stderr (per stream), guarding memory. */
const MAX_CAPTURE = 8 * 1024 * 1024;
/**
 * Run `command` once: write `input` to its stdin, capture stdout/stderr, and
 * resolve with the condensed text. Never rejects — every failure (spawn
 * error, non-zero exit, timeout, caller cancellation, empty output) resolves
 * with `text: undefined` so the caller keeps the original result.
 */
export function runRtk(command, args, input, signal, timeoutMs) {
    return new Promise((resolve) => {
        let child;
        try {
            // detached makes the child its own process-group leader so a timeout or
            // caller cancellation can SIGKILL the WHOLE group: rtk may have spawned
            // its own children, and killing only the shell leaves grandchildren
            // holding the stdio pipes open — the 'close' event would then wait for
            // them instead of resolving promptly.
            child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        }
        catch (error) {
            resolve({ text: undefined, failure: `spawn failed: ${String(error)}` });
            return;
        }
        const killGroup = () => {
            if (child.pid === undefined) {
                child.kill('SIGKILL');
                return;
            }
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch {
                // The group may already be gone (ESRCH race); fall back to the leader.
                child.kill('SIGKILL');
            }
        };
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const onAbort = () => { killGroup(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup();
        }, timeoutMs);
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        child.stdout.on('data', (chunk) => {
            if (stdout.length < MAX_CAPTURE)
                stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_CAPTURE)
                stderr += chunk;
        });
        child.on('error', (error) => settle({ text: undefined, failure: error.message }));
        child.on('close', (code, signalName) => {
            if (timedOut) {
                settle({ text: undefined, failure: `rtk timed out after ${timeoutMs}ms` });
                return;
            }
            if (signal?.aborted) {
                settle({ text: undefined, failure: 'caller cancelled' });
                return;
            }
            if (code !== 0) {
                const detail = (stderr.trim() || `exit code ${String(code)}${signalName !== null ? `, signal ${signalName}` : ''}`).slice(0, 300);
                settle({ text: undefined, failure: `rtk exited non-zero: ${detail}` });
                return;
            }
            const text = stdout;
            settle(text.length > 0
                ? { text }
                : { text: undefined, failure: 'rtk produced no output' });
        });
        // rtk may exit before reading all of stdin; an EPIPE there is covered by
        // the close handler (non-zero exit or success), so never surface it.
        child.stdin.on('error', () => { });
        child.stdin.write(input);
        child.stdin.end();
    });
}
/**
 * Assemble the replacement text: the condensed body, an optional notice line,
 * then the preserved status markers.
 */
export function buildCondensedBody(condensed, markers, inputBytes, outputBytes, notice) {
    const body = condensed.replace(/\s+$/, '');
    const parts = [body];
    if (notice) {
        parts.push(`[rtk: output condensed ${inputBytes} → ${outputBytes} bytes]`);
    }
    if (markers.length > 0) {
        parts.push(markers.join('\n'));
    }
    return parts.join('\n\n');
}
export function apply(ctx, config = {}) {
    const enabled = config.enabled ?? true;
    // Disabled ⇒ no automatic filtering: register nothing at all.
    if (!enabled)
        return;
    const configuredCommand = config.command ?? 'rtk';
    // Resolve a bare command name through PATH plus the common install dirs the
    // minimal harness PATH misses (Homebrew, Rustup).
    const command = resolveRtkPath(configuredCommand);
    const args = config.args ?? [];
    const toolSet = new Set(config.tools ?? ['bash', 'job_output']);
    const minBytes = config.minBytes ?? 2048;
    const timeoutMs = config.timeoutMs ?? 15_000;
    const notice = config.notice ?? true;
    // Rate-limit diagnostics: report each distinct failure once per load.
    const warnedFailures = new Set();
    ctx.on('tools/post-execute', async (exec, result, next) => {
        // Delegate first so a downstream listener (e.g. a hook) settles the
        // result; we condense whatever it accepted. A `block` decision and a
        // value-replacement pass through — this plugin only shapes accepted
        // plain-text projections, and value replacements must stay lossless.
        const decision = await next();
        if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value'))
            return decision;
        // Never condense corrective feedback or failure messages.
        if (result.isError)
            return decision;
        if (!toolSet.has(exec.name))
            return decision;
        const content = decision.content ?? result.content;
        const text = flattenPlainText(content);
        if (text === undefined)
            return decision;
        const inputBytes = Buffer.byteLength(text, 'utf8');
        if (inputBytes < minBytes)
            return decision;
        // Keep the trailing status markers out of rtk's reach: the condensed
        // body replaces only the output, and the markers are re-appended after it.
        const { body, markers } = splitTrailingMarkers(text);
        if (body.length === 0)
            return decision;
        const outcome = await runRtk(command, args, body, exec.signal, timeoutMs);
        if (outcome.text === undefined) {
            if (outcome.failure !== undefined && !warnedFailures.has(outcome.failure)) {
                warnedFailures.add(outcome.failure);
                ctx.logger.warn(`rtk-filter: ${outcome.failure} for ${exec.name} (${exec.callId}); keeping the original output`);
            }
            return decision;
        }
        // rtk made no change ⇒ a replacement would add only notice noise.
        if (outcome.text === body)
            return decision;
        const outputBytes = Buffer.byteLength(outcome.text, 'utf8');
        const replaced = [{
                type: 'text',
                text: buildCondensedBody(outcome.text, markers, inputBytes, outputBytes, notice),
            }];
        return {
            kind: 'accept',
            content: replaced,
            ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {},
        };
    }, { prepend: true });
}
