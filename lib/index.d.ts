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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
export declare const name = "rtk-filter";
/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export declare const inject: string[];
/** Plugin config. */
export interface Config {
    /** Master switch. `false` registers nothing (a true no-op). Default `true`. */
    enabled?: boolean;
    /**
     * The rtk executable to spawn (resolved through PATH when relative).
     * Default `'rtk'`.
     */
    command?: string;
    /** Extra CLI arguments passed to rtk. Default `[]`. */
    args?: string[];
    /**
     * Tool names whose plain-text results are piped through rtk.
     * Default `['bash', 'job_output']`.
     */
    tools?: string[];
    /**
     * Byte threshold below which a result passes through untouched.
     * Default `2048`.
     */
    minBytes?: number;
    /**
     * Per-call rtk budget in milliseconds; on expiry rtk is SIGKILLed and the
     * original output is kept. Default `15000`.
     */
    timeoutMs?: number;
    /**
     * Append a `[rtk: output condensed …]` notice line to the replacement so
     * the model knows the output was condensed. Default `true`.
     */
    notice?: boolean;
}
export declare const Config: z<Config>;
/** All-text content flattened to one string, or `undefined` if any block is non-text. */
export declare function flattenPlainText(content: ContentBlock[]): string | undefined;
/**
 * Extra directories probed when `command` is a bare name that is not on the
 * harness process PATH. The GUI/CLI is launched with a minimal environment
 * (Finder/launchd do not source the user's shell profile), so tools installed
 * by Homebrew (`/opt/homebrew/bin`) or Rustup (`~/.cargo/bin`) are invisible
 * to PATH resolution even though the user's terminal finds them.
 */
export declare const DEFAULT_RTK_CANDIDATE_DIRS: readonly ["~/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "~/.local/bin"];
/**
 * Resolve `command` to an executable path: an explicit path (containing a
 * separator) is returned verbatim; a bare name is looked up in the harness
 * PATH first and, failing that, in {@link DEFAULT_RTK_CANDIDATE_DIRS}.
 * Successes are cached; misses return the bare name so `spawn` reports the
 * usual ENOENT (the caller degrades to the original output).
 */
export declare function resolveRtkPath(command: string, candidateDirs?: readonly string[]): string;
/**
 * Split a rendered tool result into its output body and its trailing status
 * markers. A line that merely LOOKS like a marker but is part of the body
 * (e.g. a command echoed `[exit code: 1]` as its last output) is
 * indistinguishable by text alone; the split is intentionally conservative —
 * only a consecutive run of marker lines at the very end is treated as the
 * status block.
 */
export declare function splitTrailingMarkers(text: string): {
    body: string;
    markers: string[];
};
/** Outcome of one rtk invocation; `text` is `undefined` on any failure. */
export interface RtkRunResult {
    /** Condensed text from rtk's stdout, or `undefined` when rtk failed / produced nothing. */
    text: string | undefined;
    /** Human-readable failure reason for the rate-limited warn log (absent on success). */
    failure?: string;
}
/**
 * Run `command` once: write `input` to its stdin, capture stdout/stderr, and
 * resolve with the condensed text. Never rejects — every failure (spawn
 * error, non-zero exit, timeout, caller cancellation, empty output) resolves
 * with `text: undefined` so the caller keeps the original result.
 */
export declare function runRtk(command: string, args: readonly string[], input: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<RtkRunResult>;
/**
 * Assemble the replacement text: the condensed body, an optional notice line,
 * then the preserved status markers.
 */
export declare function buildCondensedBody(condensed: string, markers: readonly string[], inputBytes: number, outputBytes: number, notice: boolean): string;
export declare function apply(ctx: Context, config?: Config): void;
