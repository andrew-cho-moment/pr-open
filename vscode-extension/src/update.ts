import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runGh } from './gh';
import { log } from './logger';
import { errorMessage } from './util';
import { isNewerVersion, parseVersion } from './version';

const LAST_CHECK_KEY = 'prOpen.lastUpdateCheck';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** `owner/repo` from the extension's `repository.url`, so the release source has a single source of truth. */
function extensionRepoSlug(context: vscode.ExtensionContext): string {
  const url = (context.extension.packageJSON as { repository?: { url?: string } }).repository?.url ?? '';
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  if (!m) {
    throw new Error(`Could not determine the GitHub repo from repository.url: ${url || '(unset)'}`);
  }
  return `${m[1]}/${m[2]}`;
}

/** Download the release's VSIX into a fresh temp dir and return its path. */
async function downloadVsix(repo: string, tag: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pr-open-update-'));
  await runGh(['release', 'download', tag, '--repo', repo, '--pattern', '*.vsix', '--dir', dir]);
  const vsix = (await fs.promises.readdir(dir)).find((f) => f.endsWith('.vsix'));
  if (!vsix) {
    throw new Error(`Release ${tag} has no .vsix asset.`);
  }
  return path.join(dir, vsix);
}

/** Download + install the VSIX for `tag`, then offer a reload (the new code loads only after reload). */
async function installUpdate(repo: string, tag: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `PR Open: installing ${tag}...` },
    async () => {
      const vsixPath = await downloadVsix(repo, tag);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
      await fs.promises.rm(path.dirname(vsixPath), { recursive: true, force: true });
    },
  );
  const choice = await vscode.window.showInformationMessage(
    `PR Open ${tag} installed. Reload to activate.`,
    'Reload Window',
  );
  if (choice === 'Reload Window') {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Compare the latest GitHub release against the installed version and, when it's newer, prompt to
 * install it. Silent when up to date or on error, since this runs unattended on startup.
 */
async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
  const repo = extensionRepoSlug(context);
  const current = String(context.extension.packageJSON.version);
  const latest = (await runGh(['release', 'view', '--repo', repo, '--json', 'tagName', '--jq', '.tagName'])).trim();
  if (!latest || !isNewerVersion(current, latest)) {
    return;
  }

  const notes = `https://github.com/${repo}/releases/tag/${latest}`;
  const label = parseVersion(current) ? `${current} → ${latest}` : `${latest} (installed: ${current})`;
  const choice = await vscode.window.showInformationMessage(
    `PR Open update available: ${label}.`,
    'Install & Reload',
    'Release Notes',
  );
  if (choice === 'Install & Reload') {
    await installUpdate(repo, latest);
  } else if (choice === 'Release Notes') {
    void vscode.env.openExternal(vscode.Uri.parse(notes));
  }
}

/**
 * Auto-check for a newer release on startup: at most once per `CHECK_INTERVAL_MS`, honoring the
 * opt-out setting, and swallowing errors so a failed check never disrupts activation.
 */
export async function maybeCheckOnStartup(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.getConfiguration('prOpen').get<boolean>('checkForUpdatesOnStartup', true)) {
    return;
  }
  const last = context.globalState.get<number>(LAST_CHECK_KEY) ?? 0;
  if (Date.now() - last < CHECK_INTERVAL_MS) {
    return;
  }
  await context.globalState.update(LAST_CHECK_KEY, Date.now());
  try {
    await checkForUpdates(context);
  } catch (e) {
    log(`update check failed: ${errorMessage(e)}`);
  }
}
