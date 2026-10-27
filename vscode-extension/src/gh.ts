import { runTool } from './exec';

const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', `${process.env.HOME}/.local/bin/gh`];

/** What a caller may add beyond the argument vector. */
interface GhOpts {
  /**
   * Written to the child's stdin, which is how a GraphQL mutation carrying a list of objects reaches
   * `gh api graphql --input -`: `-f`/`-F` can only express scalar variables.
   */
  input?: string;
  /** Kills the child when the run is cancelled, so a Stop mid-call does not leave it writing. */
  signal?: AbortSignal;
}

/** Run the GitHub CLI, resolving its binary from PATH or common install locations. */
export function runGh(args: string[], cwd?: string, opts: GhOpts = {}): Promise<string> {
  return runTool('gh', args, {
    candidates: GH_CANDIDATES,
    notFound: 'The `gh` CLI was not found. Install it or add it to PATH.',
    cwd,
    ...opts,
  });
}
