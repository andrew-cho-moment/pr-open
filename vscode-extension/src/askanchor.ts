import * as path from 'path';
import { baseFields, BASE_SCHEME } from './schemes';
import { isUnder, samePath } from './util';

/** Which revision a diff pane's line numbers belong to. `head` matches the working tree on disk;
 *  `base` matches the merge base, which is nowhere on disk. */
export type Side = 'base' | 'head';

/** Where a question is aimed: a line range on one side of the PR's diff. */
export interface AskAnchor {
  /** Repo-relative path, as it appears in the diff. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  side: Side;
}

/** Whether two anchors name the same lines, so an aim already sent is not sent again. */
export function sameAnchor(a: AskAnchor | undefined, b: AskAnchor | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.file === b.file && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine;
}

/** A document identified as one side of a PR's diff. */
export interface DocRef {
  /** Repo-relative, forward-slashed. For a rename's base pane this is the old path. */
  path: string;
  side: Side;
}

/** The fields of a `vscode.Uri` anchoring needs, so this module stays vscode-free. */
export interface UriParts {
  scheme: string;
  path: string;
  /** Where `BaseContentProvider` puts a base pane's dir + ref; see `baseFragment` for why not the
   *  query. */
  fragment: string;
  fsPath: string;
}

/** Narrow a `vscode.Uri` to the fields above. Structurally typed rather than importing `vscode`,
 *  which is what keeps this module testable without the extension host. */
export function uriParts(uri: UriParts): UriParts {
  return { scheme: uri.scheme, path: uri.path, fragment: uri.fragment, fsPath: uri.fsPath };
}

/** The two commits a document's line numbers could belong to. */
export interface AnchorRepo {
  cloneDir: string;
  base: string;
  headOid: string;
}

/**
 * Which clone a document belongs to: a `pr-open-base:` URI names it in its fragment, a `file:` URI is
 * matched against clones we already know about. Undefined when neither applies.
 */
export function cloneDirFor(uri: UriParts, knownDirs: readonly string[]): string | undefined {
  if (uri.scheme === BASE_SCHEME) {
    // A base document self-describes: we minted it, so its fragment names the clone outright.
    return baseFields(uri.fragment).dir;
  }
  if (uri.scheme !== 'file') {
    return undefined;
  }
  return knownDirs.find((d) => isUnder(d, uri.fsPath));
}

/**
 * Repo-relative path plus which revision its line numbers mean. Undefined when the document is not
 * a side of this PR's diff, in which case there is nothing for the caller to anchor a question on.
 *
 * The GitHub PR extension's own left panes (`review:`, `pr:`) are deliberately excluded: their path
 * lives in an undocumented JSON blob in the query, and misreading it would anchor an answer on the
 * wrong file rather than degrade visibly. Its right pane is a real `file:` URI, so that works.
 */
export function docRefFor(uri: UriParts, repo: AnchorRepo): DocRef | undefined {
  if (uri.scheme === 'file') {
    if (!isUnder(repo.cloneDir, uri.fsPath)) {
      return undefined;
    }
    return { path: relative(repo.cloneDir, uri.fsPath), side: 'head' };
  }
  if (uri.scheme !== BASE_SCHEME) {
    return undefined;
  }
  const { dir, ref } = baseFields(uri.fragment);
  if (!dir || !samePath(dir, repo.cloneDir) || !ref) {
    return undefined;
  }
  // We only serve two refs: the merge base (the diff's left side) and, for a deleted file, HEAD.
  // Any other ref is a revision we cannot describe to the model.
  const side: Side | undefined = ref === repo.base ? 'base' : ref === repo.headOid ? 'head' : undefined;
  return side && { path: uri.path.replace(/^\/+/, ''), side };
}

function relative(dir: string, fsPath: string): string {
  return path.relative(dir, fsPath).split(path.sep).join('/');
}
