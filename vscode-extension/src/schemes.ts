/** URI scheme for the read-only base side of a PR Open diff. Shared by the content provider and the
 *  anchor resolver, which must agree on it without the resolver importing `vscode`. */
export const BASE_SCHEME = 'pr-open-base';

/**
 * How a base URI carries the clone and revision it was minted for.
 *
 * The fragment rather than the query, because the GitHub PR extension reads the query of every
 * document it is offered as its own `review:` blob, with a bare `JSON.parse` and no catch. Ours would
 * never earn a commenting range there — the pane is virtual, so it belongs to no repository the
 * extension knows — but it would make that provider throw on every step of a review.
 *
 * Here rather than at either end because three call sites read what one writes, and a format the
 * writer and the readers state separately is one a move like query-to-fragment can half-apply: a
 * reader left behind returns an empty base pane, or a document that belongs to no review, with no
 * error either way.
 */
export function baseFragment(cloneDir: string, ref: string): string {
  return `dir=${encodeURIComponent(cloneDir)}&ref=${encodeURIComponent(ref)}`;
}

/** What `baseFragment` wrote, read back. Either field is absent from a fragment that does not name it,
 *  which no URI `BaseContentProvider.uriFor` minted can be. */
export function baseFields(fragment: string): { dir?: string; ref?: string } {
  const params = new URLSearchParams(fragment);
  return { dir: params.get('dir') ?? undefined, ref: params.get('ref') ?? undefined };
}
