import { runGh } from './gh';
import { OwnedPrRef } from './prref';

/**
 * The review threads on a pull request, and the two mutations that answer one: a reply, and marking
 * it resolved.
 *
 * GraphQL rather than the REST review-comment routes, because a thread's identity, its resolved flag
 * and the mutation that resolves it exist only there. REST comments carry `in_reply_to_id` and no
 * thread id at all.
 */

/** Which side of the diff a thread hangs off, as GitHub names it. */
export enum DiffSide {
  Left = 'LEFT',
  Right = 'RIGHT',
}

/** One comment in a thread. */
export interface ThreadComment {
  /** GitHub login, or `unknown` for a comment whose author has been deleted. */
  author: string;
  body: string;
}

/** One review thread: the lines it hangs off, and the conversation on it. */
export interface ReviewThread {
  /** Node id, which is what both mutations take. */
  id: string;
  path: string;
  /** Last line of the range, absent on a file-level thread and on one GitHub can no longer place. */
  line?: number;
  /** First line of a multi-line range; absent when the thread covers a single line. */
  startLine?: number;
  side: DiffSide;
  resolved: boolean;
  /** The code under it has changed since, so its lines are not where the comment was written. */
  outdated: boolean;
  /** The patch GitHub shows above the thread, its own view of the lines it hangs off. */
  hunk: string;
  comments: ThreadComment[];
}

/** A PR's head, which decides whether pr-open may push a fix to it. */
export interface PrHeadRef {
  refName: string;
  oid: string;
  /** The head branch lives in a fork, so `origin` has no branch to push to. */
  crossRepo: boolean;
}

export interface PrReviewThreads {
  head: PrHeadRef;
  threads: ReviewThread[];
  /** A thread or a comment sat past the page below. Said out loud rather than silently dropped. */
  truncated: boolean;
}

/** One page covers every PR we have seen; `truncated` is what keeps a bigger one honest. */
const THREAD_PAGE = 100;
const COMMENT_PAGE = 50;

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefName
      headRefOid
      isCrossRepository
      reviewThreads(first:${THREAD_PAGE}){
        pageInfo{ hasNextPage }
        nodes{
          id
          path
          line
          startLine
          diffSide
          isResolved
          isOutdated
          comments(first:${COMMENT_PAGE}){
            pageInfo{ hasNextPage }
            nodes{ body author{ login } }
          }
          hunk: comments(first:1){ nodes{ diffHunk } }
        }
      }
    }
  }
}`;

const REPLY_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
    comment{ url }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`;

/** Every review thread on a PR, resolved ones included, plus the head they hang off. */
export async function fetchReviewThreads(dir: string, pr: OwnedPrRef): Promise<PrReviewThreads> {
  const out = await runGh(
    [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-f',
      `owner=${pr.owner}`,
      '-f',
      `name=${pr.repo}`,
      '-F',
      `number=${pr.number}`,
    ],
    dir,
  );
  return parseReviewThreads(out);
}

/** Post a reply on a thread. */
export async function replyToThread(dir: string, threadId: string, body: string): Promise<void> {
  await runGh(
    ['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-f', `threadId=${threadId}`, '-f', `body=${body}`],
    dir,
  );
}

/** Mark a thread resolved. */
export async function resolveThread(dir: string, threadId: string): Promise<void> {
  await runGh(['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${threadId}`], dir);
}

/**
 * Parse `gh api graphql`'s response. Split out from the call so the shape this code depends on is
 * testable without a network round trip, and so an unexpected `diffSide` fails here rather than
 * reaching a payload as a raw string.
 */
export function parseReviewThreads(json: string): PrReviewThreads {
  const pr = (JSON.parse(json) as GraphQlResponse).data?.repository?.pullRequest;
  if (!pr) {
    throw new Error('GitHub returned no pull request for that repo and number.');
  }
  if (typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string') {
    throw new Error('GitHub returned a pull request with no head ref.');
  }
  const nodes = pr.reviewThreads?.nodes ?? [];
  let truncated = pr.reviewThreads?.pageInfo?.hasNextPage === true;
  const threads: ReviewThread[] = [];
  for (const node of nodes) {
    if (!node) {
      continue;
    }
    if (node.comments?.pageInfo?.hasNextPage === true) {
      truncated = true;
    }
    threads.push(thread(node));
  }
  return {
    head: { refName: pr.headRefName, oid: pr.headRefOid, crossRepo: pr.isCrossRepository === true },
    threads,
    truncated,
  };
}

function thread(node: GraphQlThread): ReviewThread {
  if (typeof node.id !== 'string' || typeof node.path !== 'string') {
    throw new Error('GitHub returned a review thread with no id or path.');
  }
  const comments = (node.comments?.nodes ?? [])
    .filter((c): c is GraphQlComment => c !== null)
    .map((c) => ({ author: c.author?.login ?? 'unknown', body: typeof c.body === 'string' ? c.body : '' }));
  // Asked for on its own, since only the opening comment's hunk is the one GitHub renders above the
  // thread and every reply repeats it: fetching all fifty would carry the same patch fifty times.
  const opening = node.hunk?.nodes?.[0]?.diffHunk;
  const hunk = typeof opening === 'string' ? opening : '';
  return {
    id: node.id,
    path: node.path,
    line: lineNumber(node.line),
    startLine: lineNumber(node.startLine),
    side: diffSide(node.diffSide),
    resolved: node.isResolved === true,
    outdated: node.isOutdated === true,
    hunk,
    comments,
  };
}

function lineNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function diffSide(value: unknown): DiffSide {
  if (value === DiffSide.Left || value === DiffSide.Right) {
    return value;
  }
  throw new Error(`GitHub returned a review thread on an unknown diff side: ${JSON.stringify(value)}`);
}

interface GraphQlComment {
  body?: unknown;
  diffHunk?: unknown;
  author?: { login?: string } | null;
}

interface GraphQlThread {
  id?: unknown;
  path?: unknown;
  line?: unknown;
  startLine?: unknown;
  diffSide?: unknown;
  isResolved?: unknown;
  isOutdated?: unknown;
  comments?: { pageInfo?: { hasNextPage?: boolean }; nodes?: (GraphQlComment | null)[] };
  /** The `comments(first:1)` alias, for the opening comment's hunk alone. */
  hunk?: { nodes?: (GraphQlComment | null)[] };
}

interface GraphQlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        headRefName?: unknown;
        headRefOid?: unknown;
        isCrossRepository?: unknown;
        reviewThreads?: { pageInfo?: { hasNextPage?: boolean }; nodes?: (GraphQlThread | null)[] };
      } | null;
    } | null;
  };
}
