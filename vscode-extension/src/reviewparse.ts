/** One review step: a group of related hunks with a plain-English explanation. */
export interface Chunk {
  title: string;
  explanation: string;
  /** HEAD line ranges the chunk covers, 1-based. First entry is the step's primary anchor. */
  locations: { file: string; startLine: number; endLine: number }[];
}

/** Keep a model chunk inside the patches it was given; undefined when every anchor was invented. */
export function restrictChunkFiles(chunk: Chunk, allowedFiles: ReadonlySet<string>): Chunk | undefined {
  const locations = chunk.locations.filter((location) => allowedFiles.has(location.file));
  return locations.length ? { ...chunk, locations } : undefined;
}

/** Validate one parsed object into a Chunk, keeping only finite-line locations. Undefined if unusable. */
export function validateChunk(obj: unknown): Chunk | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const c = obj as Partial<Chunk>;
  if (typeof c.title !== 'string' || !Array.isArray(c.locations)) {
    return undefined;
  }
  const locations = c.locations.filter(
    (l) => l && typeof l.file === 'string' && Number.isFinite(l.startLine) && Number.isFinite(l.endLine),
  );
  if (locations.length === 0) {
    return undefined;
  }
  return { title: c.title, explanation: typeof c.explanation === 'string' ? c.explanation : '', locations };
}

/** Parse a single line expected to hold one chunk object, tolerating stray array/fence syntax. */
export function parseObjectLine(line: string): unknown {
  let t = line.trim();
  if (t.startsWith('```') || t.endsWith('```')) {
    return undefined;
  }
  if (t.startsWith('[')) {
    t = t.slice(1).trim();
  }
  if (t.endsWith(']')) {
    t = t.slice(0, -1).trim();
  }
  if (t.endsWith(',')) {
    t = t.slice(0, -1).trim();
  }
  if (!t.startsWith('{')) {
    return undefined;
  }
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Parse the whole text as a JSON array of chunks (fallback when the model ignores the JSONL format). */
export function parseArray(text: string): unknown[] {
  try {
    const arr = JSON.parse(stripFence(text));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Strip a stray markdown fence and fold the summary onto one line, which `#tourContextBody` renders
 *  `pre-wrap` (`media/panel.css`), so the model's own hard wraps would otherwise show. Sentence count
 *  is `prompt-context.md`'s contract and goes unenforced here: no rule reading a `.` as a boundary
 *  tells `e.g. Retry` or `No. 5` from the end of a sentence. */
export function cleanContextSummary(text: string): string {
  return stripFence(text).replace(/\s+/g, ' ').trim();
}

/** Strip a leading ```lang / trailing ``` fence the model may add despite instructions. */
function stripFence(s: string): string {
  const t = s.trim();
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/.exec(t);
  return fenced ? fenced[1] : t;
}
