import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ResolvedConfig {
  searchRoots: string[];
  cloneRoot: string;
  /** Model passed to `claude --model` for the guided review. Undefined = claude.ts DEFAULT_MODEL (sonnet). */
  reviewModel?: string;
  /** Model passed to `claude --model` when answering a question about the diff. Undefined = DEFAULT_MODEL. */
  askModel?: string;
  /** Model passed to `claude --model` when fixing and answering the PR's review comments. Undefined = DEFAULT_MODEL. */
  addressModel?: string;
  /** Model passed to `claude --model` for the adversarial review. Undefined = ADVERSARIAL_DEFAULT_MODEL (fable). */
  adversarialReviewModel?: string;
  /** Section of the user's CLAUDE.md that sets the design standard an adversarial finding is judged
   *  against. Empty means the whole file, as does a file carrying neither this section nor the voice. */
  adversarialStandardsSection: string;
  /** Section of the user's CLAUDE.md that sets the voice of an adversarial finding. Empty means the
   *  whole file; a name the file does not carry takes whatever the standard section did not claim. */
  adversarialInstructionsSection: string;
  /** Show bounded business context extracted from the PR description above the guided review. */
  includeBusinessContext: boolean;
  /** Log each action's phase breakdown, not just its total. Undefined = off. */
  logTimings: boolean | undefined;
}

/** Expand a leading `~` and normalize to an absolute path. */
function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return trimmed;
}

/**
 * Read and validate `prOpen.searchRoots`. Validation happens here (activation / config
 * change) rather than at use, so a bad config fails loudly with a specific reason instead
 * of silently resolving nothing. Throws `ConfigError` on any invalid value.
 */
export function readConfig(): ResolvedConfig {
  const cfg = vscode.workspace.getConfiguration('prOpen');
  const raw = cfg.get<unknown>('searchRoots');

  if (raw === undefined) {
    throw new ConfigError('`prOpen.searchRoots` is not set. Add at least one directory to scan for clones.');
  }
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string') || raw.length === 0) {
    throw new ConfigError('`prOpen.searchRoots` must be a non-empty array of directory paths.');
  }

  const searchRoots = (raw as string[]).map(expandHome);
  for (const root of searchRoots) {
    if (!path.isAbsolute(root)) {
      throw new ConfigError(`Search root is not an absolute path: ${root}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      throw new ConfigError(`Search root does not exist: ${root}`);
    }
    if (!stat.isDirectory()) {
      throw new ConfigError(`Search root is not a directory: ${root}`);
    }
  }

  const cloneRootRaw = cfg.get<unknown>('cloneRoot');
  let cloneRoot = searchRoots[0];
  if (cloneRootRaw !== undefined) {
    if (typeof cloneRootRaw !== 'string') {
      throw new ConfigError('`prOpen.cloneRoot` must be a string.');
    }
    cloneRoot = expandHome(cloneRootRaw);
    if (!searchRoots.includes(cloneRoot)) {
      throw new ConfigError('`prOpen.cloneRoot` must be one of `prOpen.searchRoots`.');
    }
  }

  const reviewModel = readModel(cfg, 'review.model');
  const askModel = readModel(cfg, 'ask.model');
  const addressModel = readModel(cfg, 'address.model');
  const adversarialReviewModel = readModel(cfg, 'adversarialReview.model');

  const adversarialStandardsSection = readSection(cfg, STANDARDS_KEY);
  const adversarialInstructionsSection = readSection(cfg, INSTRUCTIONS_KEY);

  const businessContextRaw = cfg.get<unknown>('review.includeBusinessContext');
  if (typeof businessContextRaw !== 'boolean') {
    throw new ConfigError('`prOpen.review.includeBusinessContext` must be a boolean.');
  }
  const includeBusinessContext = businessContextRaw;

  const logTimingsRaw = cfg.get<unknown>('logTimings');
  if (logTimingsRaw !== undefined && typeof logTimingsRaw !== 'boolean') {
    throw new ConfigError('`prOpen.logTimings` must be a boolean.');
  }

  return {
    searchRoots,
    cloneRoot,
    reviewModel,
    askModel,
    addressModel,
    adversarialReviewModel,
    adversarialStandardsSection,
    adversarialInstructionsSection,
    includeBusinessContext,
    logTimings: logTimingsRaw,
  };
}

/** A section-name setting. The manifest declares a default, so anything but a string is a bad edit. */
function readSection(cfg: vscode.WorkspaceConfiguration, key: string): string {
  const raw = cfg.get<unknown>(key);
  if (typeof raw !== 'string') {
    throw new ConfigError(`\`prOpen.${key}\` must be a string.`);
  }
  return raw.trim();
}

const STANDARDS_KEY = 'adversarialReview.standardsSection';
const INSTRUCTIONS_KEY = 'adversarialReview.instructionsSection';

/**
 * Which two sections of the reader's CLAUDE.md an adversarial run reads, from one `readConfig`.
 *
 * Holds no default of its own. `readConfig` rejects a bad `searchRoots`, which has nothing to do
 * with which section of a personal file a run reads, so this falls back to what `package.json`
 * declares, read from the manifest rather than copied into a constant that would then need its own
 * test to stay in step.
 */
export function adversarialSections(): { standard: string; voice: string } {
  const resolved = configured((c) => ({
    standard: c.adversarialStandardsSection,
    voice: c.adversarialInstructionsSection,
  }));
  if (resolved) {
    return resolved;
  }
  const cfg = vscode.workspace.getConfiguration('prOpen');
  return { standard: declaredDefault(cfg, STANDARDS_KEY), voice: declaredDefault(cfg, INSTRUCTIONS_KEY) };
}

/**
 * The `default` `package.json` declares for a setting, which both section settings carry.
 *
 * Throws rather than falling back to `''`, because `''` is a section name the reader can choose and
 * it means the whole file for both jobs. A key renamed in the manifest and left alone here would
 * otherwise change what a run appends without saying so.
 */
function declaredDefault(cfg: vscode.WorkspaceConfiguration, key: string): string {
  const declared = cfg.inspect<string>(key)?.defaultValue;
  if (declared === undefined) {
    throw new ConfigError(`\`prOpen.${key}\` declares no default. The extension manifest and \`config.ts\` disagree on its name.`);
  }
  return declared;
}

/** An optional `--model` setting: unset (or blank) means the default, anything else must be a name. */
function readModel(cfg: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const raw = cfg.get<unknown>(key);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(`\`prOpen.${key}\` must be a model name string.`);
  }
  return raw.trim();
}

export class ConfigError extends Error {}

/**
 * One value picked out of the config, or undefined when the config is unreadable. A bad config is
 * already surfaced at activation, and no run is worth failing over which model or section it names.
 *
 * Generic over the pick so a caller needing two settings takes them from one `readConfig`, which
 * stats every `prOpen.searchRoots` entry synchronously and could otherwise straddle an edit.
 */
export function configured<T>(pick: (config: ResolvedConfig) => T): T | undefined {
  try {
    return pick(readConfig());
  } catch {
    return undefined;
  }
}
