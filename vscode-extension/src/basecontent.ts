import * as vscode from 'vscode';
import { showFile } from './git';
import { baseFields, baseFragment, BASE_SCHEME } from './schemes';

/**
 * Serves the base (merge-base) side of a guided-review diff as a read-only virtual document.
 * The right side of the diff is the real on-disk file, so the base must be virtual (it is a
 * historical revision not on disk). Content at a fixed sha is immutable, so it is cached
 * forever within a session and cleared when a tour ends.
 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = BASE_SCHEME;
  private readonly cache = new Map<string, string>();

  /** Build a URI whose path drives the language mode and whose fragment carries dir + ref; see
   *  {@link baseFragment} for why the fragment and not the query. */
  static uriFor(cloneDir: string, ref: string, repoRelPath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: BaseContentProvider.scheme,
      path: '/' + repoRelPath.replace(/^\/+/, ''),
      fragment: baseFragment(cloneDir, ref),
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const { dir, ref } = baseFields(uri.fragment);
    if (!dir || !ref) {
      return '';
    }
    const content = await showFile(dir, ref, uri.path.replace(/^\/+/, ''));
    this.cache.set(key, content);
    return content;
  }

  clear(): void {
    this.cache.clear();
  }
}
