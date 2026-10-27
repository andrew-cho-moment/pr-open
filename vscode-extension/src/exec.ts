import { execFile, spawn } from 'child_process';
import * as fs from 'fs';

const resolved = new Map<string, string>();

/**
 * Resolve a CLI binary: PATH first (the bare name), then common install locations, since the
 * extension host's PATH often lacks Homebrew. Memoized per name for the session.
 */
export function resolveBinary(name: string, candidates: string[]): string {
  const hit = resolved.get(name);
  if (hit !== undefined) {
    return hit;
  }
  const found = candidates.find((p) => fs.existsSync(p)) ?? name;
  resolved.set(name, found);
  return found;
}

/** What both runners honour. Buffered-only options stay on `ExecOpts`, so the streaming runner
 * cannot silently drop them. */
interface ToolOpts {
  candidates: string[];
  /** Message thrown when the binary is missing (ENOENT). */
  notFound: string;
  cwd?: string;
  /** Overlaid on the extension host's environment, which the child otherwise inherits whole. */
  env?: Record<string, string>;
  /** Written to the child's stdin, then closed. */
  input?: string;
  /** Rejects before launch when already aborted and kills a running child when aborted later. */
  signal?: AbortSignal;
}

interface ExecOpts extends ToolOpts {
  maxBuffer?: number;
}

/** Map a spawn/exec `error` to the not-found hint on ENOENT, else to the tool's own stderr when it
 *  said anything, else the generic message the runtime produced. */
function spawnError(err: unknown, notFound: string, stderr = ''): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return err;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return new Error(code === 'ENOENT' ? notFound : stderr || (err as Error).message);
}

/** Write `input` to the child's stdin and close it; swallow EPIPE if the child exits early. */
function writeStdin(child: { stdin: NodeJS.WritableStream | null }, input?: string): void {
  if (input === undefined) {
    return;
  }
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
}

/** Run an external tool via `execFile` (no shell) and resolve its stdout, or reject with a
 * normalized error: the not-found hint on ENOENT, else the trimmed stderr. */
export function runTool(name: string, args: string[], opts: ExecOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = execFile(
      resolveBinary(name, opts.candidates),
      args,
      {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          // Prefer the tool's stderr over the generic exec message, except on ENOENT.
          reject(spawnError(err, opts.notFound, stderr.trim()));
        } else {
          resolve(stdout);
        }
      },
    );
    writeStdin(child, opts.input);
  });
}

/**
 * Like `runTool`, but delivers stdout to `onStdout` in arrival order rather than buffering it all.
 * Resolves on a clean (code 0) exit, rejects with the same normalized error as `runTool`. Used for
 * streaming CLIs whose output is consumed incrementally (e.g. `claude --output-format stream-json`).
 */
export function runToolStreaming(
  name: string,
  args: string[],
  opts: ToolOpts,
  onStdout: (data: string) => void,
): Promise<void> {
  return runToolStreamingOutput(name, args, opts, 'utf8', (data) => onStdout(data as string));
}

/** Stream a tool's stdout as raw bytes. Used by framed protocols whose byte counts would be broken
 * by UTF-8 decoding before their records are split. */
export function runToolStreamingBytes(
  name: string,
  args: string[],
  opts: ToolOpts,
  onStdout: (data: Buffer) => void,
): Promise<void> {
  return runToolStreamingOutput(name, args, opts, undefined, (data) => onStdout(data as Buffer));
}

function runToolStreamingOutput(
  name: string,
  args: string[],
  opts: ToolOpts,
  encoding: BufferEncoding | undefined,
  onStdout: (data: string | Buffer) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn(resolveBinary(name, opts.candidates), args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      signal: opts.signal,
    });
    let stderr = '';
    let settled = false;
    let failure: Error | undefined;
    child.on('error', (err) => {
      if (!settled) {
        failure ??= spawnError(err, opts.notFound);
      }
    });
    if (encoding !== undefined) {
      child.stdout.setEncoding(encoding);
    }
    child.stdout.on('data', (data: string | Buffer) => {
      if (settled || failure !== undefined) {
        return;
      }
      try {
        onStdout(data);
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err));
        child.stdout.pause();
        child.stdout.destroy();
        child.kill();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (failure !== undefined) {
        reject(failure);
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${name} exited with code ${code ?? 'null'}`));
      }
    });
    writeStdin(child, opts.input);
  });
}

/** Read at most `limit` stdout bytes, then stop the process and resolve after it has closed. */
export function runToolPrefix(name: string, args: string[], opts: ToolOpts, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return Promise.reject(new Error('Tool output prefix limit must be a positive safe integer.'));
  }

  return new Promise<Buffer>((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn(resolveBinary(name, opts.candidates), args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      signal: opts.signal,
    });
    const parts: Buffer[] = [];
    let length = 0;
    let limited = false;
    let stderr = '';
    let failure: Error | undefined;

    child.on('error', (err) => {
      failure ??= spawnError(err, opts.notFound);
    });
    child.stdout.on('data', (data: Buffer) => {
      if (limited || failure !== undefined) {
        return;
      }
      const keep = Math.min(data.length, limit - length);
      if (keep > 0) {
        parts.push(data.subarray(0, keep));
        length += keep;
      }
      if (length === limit) {
        limited = true;
        child.stdout.pause();
        child.stdout.destroy();
        child.kill();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      stderr += data;
    });
    child.on('close', (code) => {
      if (failure !== undefined) {
        reject(failure);
      } else if (limited || code === 0) {
        resolve(Buffer.concat(parts, length));
      } else {
        reject(new Error(stderr.trim() || `${name} exited with code ${code ?? 'null'}`));
      }
    });
    writeStdin(child, opts.input);
  });
}
