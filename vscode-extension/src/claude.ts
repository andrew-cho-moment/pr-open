import { runTool } from './exec';

/** Where `claude` is commonly installed, since the extension host's PATH often lacks Homebrew. */
export const CLAUDE_CANDIDATES = [
  `${process.env.HOME}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

export const CLAUDE_NOT_FOUND = 'The `claude` CLI was not found. Install Claude Code or add it to PATH.';

/** Model used when the relevant `prOpen.*.model` is unset. Sonnet chunks a diff fast; override for depth. */
export const DEFAULT_MODEL = 'sonnet';

/**
 * Model for the adversarial review, which hunts for bugs rather than chunking a diff, and is worth
 * the slower and more capable default. An alias rather than a pinned id, so it follows the newest
 * release without a version bump. Resolved at the call site, not here: `configured` returns
 * undefined on an unreadable config, which would otherwise fall through to `DEFAULT_MODEL`.
 */
export const ADVERSARIAL_DEFAULT_MODEL = 'fable';

/** Empty MCP config so `--strict-mcp-config` starts a subprocess with no MCP servers. */
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/** Tools an ask subprocess may use: enough to follow a caller or read a definition, nothing that writes. */
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/** Adds editing the working tree. No Bash: pr-open owns every git command, so a subprocess that
 *  cannot run one can neither commit nor push what it wrote. */
const EDIT_TOOLS = `${READ_ONLY_TOOLS},Edit,Write`;

/**
 * What a claude subprocess may touch. `'none'` for the pure-text walkthrough; `'read-only'` for
 * questions that must look beyond the diff they were handed; `'edit'` for the pass that fixes what
 * a reviewer asked for.
 */
export type ClaudeTools = 'none' | 'read-only' | 'edit';

const TOOL_NAMES: Record<ClaudeTools, string> = {
  none: '',
  'read-only': READ_ONLY_TOOLS,
  edit: EDIT_TOOLS,
};

/** Whether a subprocess needs a resumable Claude Code session on disk. */
export enum ClaudeSessionPersistence {
  Persistent = 'persistent',
  Ephemeral = 'ephemeral',
}

/**
 * How a run's own prompt meets the CLI's.
 *
 * Appending keeps the default prompt, which is what explains the tools and injects the cwd, so a run
 * with tools that replaced it would make the model tool-shy. A run with no tools has nothing to lose
 * by replacing it, and gains a prompt that says only what its output format is.
 */
export enum ClaudeSystemPrompt {
  Replace = '--system-prompt',
  Append = '--append-system-prompt',
}

export interface ClaudeStreamRun {
  model?: string;
  systemPrompt: { mode: ClaudeSystemPrompt; text: string };
  tools: ClaudeTools;
  persistence?: ClaudeSessionPersistence;
  /** A session to continue rather than start. */
  resume?: string;
}

/** The whole argument vector for a streaming run, so no caller re-spells the output format. */
export async function claudeStreamArgs(run: ClaudeStreamRun): Promise<string[]> {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model',
    run.model ?? DEFAULT_MODEL,
    run.systemPrompt.mode,
    run.systemPrompt.text,
    ...(await claudeIsolationArgs(run.tools, run.persistence)),
    ...(run.resume ? ['--resume', run.resume] : []),
  ];
}

/**
 * Pin a subprocess to a known-empty environment: no settings (hence no hooks, no project
 * permissions, no CLAUDE.md), no MCP servers, and exactly this toolset.
 *
 * `--tools` bounds what the model *has*, so anything outside the list is unrepresentable rather
 * than merely denied; `--allowed-tools` then keeps the survivors from needing a permission prompt
 * that `-p` cannot answer, and `dontAsk` denies anything unforeseen instead of stalling.
 */
export function isolationArgs(tools: ClaudeTools): string[] {
  const names = TOOL_NAMES[tools];
  return [
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
    '--tools',
    names,
    '--allowed-tools',
    names,
    '--permission-mode',
    'dontAsk',
  ];
}

let help: Promise<string> | undefined;

/**
 * Full isolation supported by the installed CLI. Capability detection keeps older Claude Code
 * releases working while newer ones shed commands, skills, agents and throwaway session state.
 */
export async function claudeIsolationArgs(
  tools: ClaudeTools,
  persistence: ClaudeSessionPersistence = ClaudeSessionPersistence.Persistent,
): Promise<string[]> {
  help ??= runTool('claude', ['--help'], {
    candidates: CLAUDE_CANDIDATES,
    notFound: CLAUDE_NOT_FOUND,
  }).catch(() => '');
  return [...supportedIsolationFlags(await help, persistence), ...isolationArgs(tools)];
}

/** Optional flags named by `claude --help`, split out so compatibility has no subprocess in tests. */
export function supportedIsolationFlags(helpText: string, persistence: ClaudeSessionPersistence): string[] {
  const flags: string[] = [];
  if (helpText.includes('--safe-mode')) {
    flags.push('--safe-mode');
  }
  if (helpText.includes('--disable-slash-commands')) {
    flags.push('--disable-slash-commands');
  }
  if (persistence === ClaudeSessionPersistence.Ephemeral && helpText.includes('--no-session-persistence')) {
    flags.push('--no-session-persistence');
  }
  return flags;
}
