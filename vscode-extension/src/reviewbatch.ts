import { annotateDiff } from './diffannotate';
import { ReviewDiff, ReviewFileDisposition, ReviewFilePatch, ReviewSection } from './git';
import { Chunk } from './reviewparse';
import { errorMessage } from './util';

export const REVIEW_PAYLOAD_BUDGET = 200_000;
export const REVIEW_MANIFEST_BUDGET = 24_000;
const PAYLOAD_FRAMING_RESERVE = 1_024;

export interface ReviewScope {
  reviewedFiles: number;
  omittedFiles: number;
  omittedAdditions: number;
  omittedDeletions: number;
  rawBytes: number;
  reviewableBytes: number;
  manifestBytes: number;
  batches: number;
}

export interface ReviewBatch {
  input: string;
  files: readonly string[];
}

export interface PreparedReview {
  batches: ReviewBatch[];
  scope: ReviewScope;
}

type DerivedArtifactDisposition =
  ReviewFileDisposition.Generated | ReviewFileDisposition.Vendored | ReviewFileDisposition.Binary;

interface DerivedArtifactManifestEntry {
  disposition: DerivedArtifactDisposition;
  path: string;
  additions: number;
  deletions: number;
}

interface ReviewPiece {
  file: string;
  text: string;
}

interface PendingBatch {
  pieces: ReviewPiece[];
  files: Set<string>;
  length: number;
}

export type ReviewBatchRunner = (
  batch: ReviewBatch,
  index: number,
  total: number,
  onChunk: (chunk: Chunk) => void,
) => Promise<void>;

/** Reduce a raw review diff to bounded, ordered model inputs plus a persistent scope summary. */
export function prepareReview(diff: ReviewDiff): PreparedReview {
  const reviewable = diff.files
    .filter((f) => f.disposition === ReviewFileDisposition.Reviewable)
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section));
  const omitted = diff.files.filter(isDerivedArtifact);
  const manifestEntries = omitted.map((file) => ({
    disposition: file.disposition,
    path: file.file.path,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const manifest = artifactManifest(manifestEntries);
  const firstBodyBudget = REVIEW_PAYLOAD_BUDGET - manifest.length - PAYLOAD_FRAMING_RESERVE;
  const laterBodyBudget = REVIEW_PAYLOAD_BUDGET - PAYLOAD_FRAMING_RESERVE;
  if (firstBodyBudget <= 0) {
    throw new Error('The derived-artifact manifest leaves no room for reviewable code.');
  }

  const pieces = reviewable.flatMap((file, index) =>
    splitReviewPatch(file, index === 0 ? firstBodyBudget : laterBodyBudget),
  );
  const packed: PendingBatch[] = [];
  let current: PendingBatch | undefined;
  for (const piece of pieces) {
    const bodyBudget = packed.length === 0 ? firstBodyBudget : laterBodyBudget;
    if (current && current.length + pendingSeparator(current) + piece.text.length > bodyBudget) {
      packed.push(current);
      current = undefined;
    }
    current ??= { pieces: [], files: new Set(), length: 0 };
    current.length += pendingSeparator(current) + piece.text.length;
    current.pieces.push(piece);
    current.files.add(piece.file);
  }
  if (current) {
    packed.push(current);
  }

  const batches = packed.map((batch, i) => {
    const input = reviewPayload(i === 0 ? manifest : '', batch.pieces.map((p) => p.text).join('\n'), i, packed.length);
    if (input.length > REVIEW_PAYLOAD_BUDGET) {
      throw new Error(
        `Review batch ${i + 1} is ${input.length} characters, over the ${REVIEW_PAYLOAD_BUDGET}-character budget.`,
      );
    }
    return { input, files: [...batch.files] };
  });
  return {
    batches,
    scope: {
      reviewedFiles: reviewable.length,
      omittedFiles: omitted.length,
      omittedAdditions: omitted.reduce((n, f) => n + f.additions, 0),
      omittedDeletions: omitted.reduce((n, f) => n + f.deletions, 0),
      rawBytes: diff.rawBytes,
      reviewableBytes: reviewable.reduce((n, f) => n + Buffer.byteLength(f.patch), 0),
      manifestBytes: Buffer.byteLength(manifest),
      batches: batches.length,
    },
  };
}

/** Run prepared batches in order and suppress exact duplicates across independent model sessions. */
export async function runReviewBatches(
  batches: readonly ReviewBatch[],
  run: ReviewBatchRunner,
  onChunk?: (chunk: Chunk) => void,
  signal?: AbortSignal,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < batches.length; i++) {
    signal?.throwIfAborted();
    try {
      await run(batches[i], i, batches.length, (chunk) => {
        const key = JSON.stringify(chunk);
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        chunks.push(chunk);
        onChunk?.(chunk);
      });
    } catch (e) {
      signal?.throwIfAborted();
      throw new Error(`Review batch ${i + 1}/${batches.length} failed: ${errorMessage(e)}`);
    }
    signal?.throwIfAborted();
  }
  return chunks;
}

function pendingSeparator(batch: PendingBatch): number {
  return batch.pieces.length ? 1 : 0;
}

function sectionRank(section: ReviewSection): number {
  switch (section) {
    case ReviewSection.Contract:
      return 0;
    case ReviewSection.Production:
      return 1;
    case ReviewSection.Test:
      return 2;
  }
}

function isDerivedArtifact(
  file: ReviewFilePatch,
): file is ReviewFilePatch & { disposition: DerivedArtifactDisposition } {
  return file.disposition !== ReviewFileDisposition.Reviewable;
}

/** A bounded list with exact totals even when a dependency bump changes thousands of files. */
function artifactManifest(files: readonly DerivedArtifactManifestEntry[]): string {
  if (files.length === 0) {
    return '';
  }
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const lines = [
    '### OMITTED DERIVED ARTIFACTS',
    `${files.length} generated, vendored, or binary files (+${additions}/-${deletions}) were omitted from the reviewable diff.`,
    'Use this manifest only to understand regeneration collateral. Never create a review location in one of these files.',
  ];
  // Track the running join length instead of re-joining on every file, since a PR can touch
  // thousands of derived files.
  let joinLength = lines.reduce((n, line, i) => n + line.length + (i > 0 ? 1 : 0), 0);
  let shown = 0;
  for (const file of files) {
    const line = `${file.disposition} ${file.path} +${file.additions}/-${file.deletions}`;
    const withLine = joinLength + 1 + line.length;
    const tail = moreFilesLine(files.length, shown + 1);
    const withTail = tail ? withLine + 1 + tail.length : withLine;
    if (withTail > REVIEW_MANIFEST_BUDGET) {
      break;
    }
    lines.push(line);
    joinLength = withLine;
    shown++;
  }
  if (shown < files.length) {
    lines.push(moreFilesLine(files.length, shown));
  }
  return lines.join('\n');
}

function moreFilesLine(total: number, shown: number): string {
  const remaining = total - shown;
  return remaining > 0 ? `... ${remaining} more derived files remain in the totals above.` : '';
}

function reviewPayload(manifest: string, body: string, index: number, total: number): string {
  const out = [
    `### REVIEW BATCH ${index + 1}/${total}`,
    'This batch is one ordered part of the pull request. Return review chunks only for files present in its reviewable diff.',
  ];
  if (manifest) {
    out.push('', manifest);
  }
  out.push('', '### REVIEWABLE DIFF', body);
  return out.join('\n');
}

/** Annotate once, then split at file and hunk boundaries without recomputing line numbers. */
function splitReviewPatch(file: ReviewFilePatch, budget: number): ReviewPiece[] {
  const annotated = annotateDiff(file.patch);
  if (annotated.length <= budget) {
    return [{ file: file.file.path, text: annotated }];
  }
  const lines = annotated.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) {
    return splitReviewLines(file.file.path, [lines[0]], lines.slice(1), budget);
  }
  const header = lines.slice(0, firstHunk);
  const starts: number[] = [];
  for (let i = firstHunk; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) {
      starts.push(i);
    }
  }
  const pieces: ReviewPiece[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? lines.length;
    const hunkHeader = lines[start];
    const whole = [...header, ...lines.slice(start, end)].join('\n');
    if (whole.length <= budget) {
      pieces.push({ file: file.file.path, text: whole });
    } else {
      pieces.push(...splitReviewLines(file.file.path, [...header, hunkHeader], lines.slice(start + 1, end), budget));
    }
  }
  return pieces;
}

function splitReviewLines(
  file: string,
  prefix: readonly string[],
  lines: readonly string[],
  budget: number,
): ReviewPiece[] {
  const prefixText = prefix.join('\n');
  if (prefixText.length > budget) {
    throw new Error(`Reviewable diff header in ${file} exceeds the ${REVIEW_PAYLOAD_BUDGET}-character request budget.`);
  }
  const pieces: ReviewPiece[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const text = [...prefix, ...current, line].join('\n');
    if (text.length > budget) {
      if (current.length === 0) {
        throw new Error(`A reviewable line in ${file} exceeds the ${REVIEW_PAYLOAD_BUDGET}-character request budget.`);
      }
      pieces.push({ file, text: [...prefix, ...current].join('\n') });
      current = [];
      if ([...prefix, line].join('\n').length > budget) {
        throw new Error(`A reviewable line in ${file} exceeds the ${REVIEW_PAYLOAD_BUDGET}-character request budget.`);
      }
    }
    current.push(line);
  }
  if (current.length || pieces.length === 0) {
    pieces.push({ file, text: [...prefix, ...current].join('\n') });
  }
  return pieces;
}
