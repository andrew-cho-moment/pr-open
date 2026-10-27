import { readFile } from 'fs/promises';
import {
  CLAUDE_CANDIDATES,
  CLAUDE_NOT_FOUND,
  claudeIsolationArgs,
  ClaudeSessionPersistence,
  claudeStreamArgs,
  ClaudeSystemPrompt,
  DEFAULT_MODEL,
} from './claude';
import { streamClaudeJsonl } from './claudejsonl';
import { runTool } from './exec';
import { log } from './logger';
import { ReviewBatch, runReviewBatches } from './reviewbatch';
import { Chunk, restrictChunkFiles, validateChunk } from './reviewparse';

export type { Chunk } from './reviewparse';

/**
 * Run the `claude` CLI on a diff and parse the ordered chunks it returns. The full system prompt
 * lives in `prompt-review.md` at the extension root, so it is easy to find and edit.
 *
 * The prompt asks for newline-delimited JSON (one chunk object per line), and we run the CLI in
 * `stream-json` mode: each chunk is parsed and handed to `onChunk` the moment its line completes, so
 * the caller can show the first step while the rest are still generating. The subprocess is stripped
 * of settings, MCP servers, and tools it never needs, which trims fixed startup latency.
 */
export async function generateWalkthrough(
  input: string,
  promptPath: string,
  model?: string,
  onChunk?: (chunk: Chunk) => void,
  allowedFiles?: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Chunk[]> {
  signal?.throwIfAborted();
  const args = await claudeStreamArgs({
    model,
    systemPrompt: { mode: ClaudeSystemPrompt.Replace, text: (await readFile(promptPath, 'utf8')).trim() },
    tools: 'none',
    persistence: ClaudeSessionPersistence.Ephemeral,
  });

  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  const emit = (obj: unknown) => {
    const parsed = validateChunk(obj);
    const chunk = parsed && allowedFiles ? restrictChunkFiles(parsed, allowedFiles) : parsed;
    if (!chunk) {
      return;
    }
    const key = JSON.stringify(chunk);
    if (seen.has(key)) {
      return; // a fallback pass may revisit text already streamed
    }
    seen.add(key);
    chunks.push(chunk);
    onChunk?.(chunk);
  };

  log(`review: claude --model ${model ?? DEFAULT_MODEL}, input ${Buffer.byteLength(input)} bytes`);
  await streamClaudeJsonl({
    args,
    input,
    signal,
    label: 'review',
    onObject: emit,
    accepted: () => chunks.length,
    emptyMessage: 'Claude did not return any review chunks',
  });
  return chunks;
}

/** Run bounded inputs in order and suppress exact duplicates across independent Claude sessions. */
export function generateWalkthroughBatches(
  batches: readonly ReviewBatch[],
  promptPath: string,
  model?: string,
  onChunk?: (chunk: Chunk) => void,
  signal?: AbortSignal,
): Promise<Chunk[]> {
  return runReviewBatches(
    batches,
    async (batch, index, total, emit) => {
      log(`review: batch ${index + 1}/${total}, ${Buffer.byteLength(batch.input)} bytes, ${batch.files.length} files`);
      await generateWalkthrough(batch.input, promptPath, model, emit, new Set(batch.files), signal);
    },
    onChunk,
    signal,
  );
}

/** Summarize the concrete problem and resolution from the PR title and description, as the model
 *  wrote it: cleaning happens where it is displayed, so what a caller caches needs no re-cleaning
 *  when that changes. */
export async function summarizeContext(
  title: string,
  body: string,
  promptPath: string,
  model?: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const source = `Title: ${title}\n\nDescription:\n${body.trim() || '(no description provided)'}`;
  const systemPrompt = (await readFile(promptPath, 'utf8')).trim();
  const args = [
    '-p',
    '--model',
    model ?? DEFAULT_MODEL,
    '--system-prompt',
    systemPrompt,
    ...(await claudeIsolationArgs('none', ClaudeSessionPersistence.Ephemeral)),
  ];
  log(`context: claude --model ${model ?? DEFAULT_MODEL}, source ${Buffer.byteLength(source)} bytes`);
  const out = await runTool('claude', args, {
    candidates: CLAUDE_CANDIDATES,
    notFound: CLAUDE_NOT_FOUND,
    input: source,
    signal,
    maxBuffer: 1024 * 1024,
  });
  return out;
}
