import { DiffAnchors, isAnchorLegal, isRangeLegal } from './diffanchors';
import { runGh } from './gh';
import { OwnedPrRef } from './prref';
import { DiffSide } from './prthreads';

/**
 * Filing an adversarial review's findings as inline comments on a *pending* pull request review.
 *
 * Pending is the whole contract: a review created with no `event` is a draft only its author can
 * see, and it reaches the PR author when they press Submit on github.com, never because pr-open
 * posted it. `PullRequestReviewEvent` has no `PENDING` member, so the state is produced by omitting
 * the field — which is why `createReviewRequest` is tested for the absence of the key rather than
 * for the presence of a value.
 *
 * GraphQL rather than the REST reviews route, for a different reason than `prthreads.ts` gives:
 * REST's `comments[]` still carries the deprecated diff-relative `position` alongside `line`, and
 * `DraftPullRequestReviewThread` has no `position` field at all, so the wrong-coordinate mistake is
 * unrepresentable here.
 */

/** One finding, in the vocabulary the prompt and the annotated diff share. */
export interface ReviewFinding {
  file: string;
  /** Last line of the range, which is the line a single-line comment hangs off. */
  line: number;
  /** First line of a multi-line range; absent when the finding covers one line. */
  startLine?: number;
  side: DiffSide;
  body: string;
}

/** One inline comment, in GitHub's vocabulary. `path` and `startLine` are its names, not ours. */
export interface DraftThread {
  path: string;
  body: string;
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
}

/** Why a finding never became a comment. Each is a claim the model made that the diff does not bear. */
export enum DropReason {
  FileNotInDiff = 'file-not-in-diff',
  LineNotInDiff = 'line-not-in-diff',
  RangeSpansHunks = 'range-spans-hunks',
}

export interface DroppedFinding {
  finding: ReviewFinding;
  reason: DropReason;
}

export interface ThreadPlan {
  threads: DraftThread[];
  dropped: DroppedFinding[];
}

/**
 * Turn findings into draft threads, dropping the ones the diff cannot carry.
 *
 * Dropping rather than failing: one hallucinated line number would otherwise discard every other
 * finding in the batch, and GitHub rejects the whole mutation if a single comment is off-diff.
 * What was dropped is not lost — the caller puts it in the review body.
 */
export function planThreads(findings: readonly ReviewFinding[], anchors: DiffAnchors): ThreadPlan {
  const threads: DraftThread[] = [];
  const dropped: DroppedFinding[] = [];
  for (const finding of findings) {
    if (!anchors.has(finding.file)) {
      dropped.push({ finding, reason: DropReason.FileNotInDiff });
      continue;
    }
    // A range that starts where it ends is a single-line comment; GitHub rejects startLine === line.
    const startLine = finding.startLine !== undefined && finding.startLine < finding.line ? finding.startLine : undefined;
    // Endpoints first, so a range whose end simply is not in the diff is not reported to the PR
    // author as having straddled two hunks. `isRangeLegal` fails for both, and only one is true.
    const ends = startLine === undefined ? [finding.line] : [startLine, finding.line];
    if (ends.some((l) => !isAnchorLegal(anchors, finding.file, l, finding.side))) {
      dropped.push({ finding, reason: DropReason.LineNotInDiff });
      continue;
    }
    if (startLine !== undefined && !isRangeLegal(anchors, finding.file, startLine, finding.line, finding.side)) {
      dropped.push({ finding, reason: DropReason.RangeSpansHunks });
      continue;
    }
    threads.push({
      path: finding.file,
      body: threadBody(finding),
      line: finding.line,
      side: finding.side,
      ...(startLine !== undefined ? { startLine, startSide: finding.side } : {}),
    });
  }
  return { threads, dropped };
}

/** One comment's body. */
export function threadBody(finding: ReviewFinding): string {
  return finding.body.trim();
}

/**
 * The review's summary comment: the findings that could not be anchored, so a dropped one is visible
 * rather than silently gone. Empty when every finding anchored, since GitHub already marks the review
 * as pending.
 */
export function reviewBody(dropped: readonly DroppedFinding[]): string {
  if (dropped.length === 0) {
    return '';
  }
  const lines = ['### Findings that could not be anchored to the diff', ''];
  for (const d of dropped) {
    const at = `${d.finding.file}:${d.finding.line} (${d.finding.side})`;
    lines.push(`- \`${at}\` — ${d.reason}\n\n  ${d.finding.body.trim().replace(/\n/g, '\n  ')}`);
  }
  return lines.join('\n');
}

/** The PR's node id and head, plus the viewer's own pending review when one is already open. */
export interface PendingReviewTarget {
  pullRequestId: string;
  headOid: string;
  /** A draft the viewer already holds. GitHub allows only one per PR, so a create would fail. */
  pending?: { id: string; url: string };
}

export enum ReviewState {
  Pending = 'PENDING',
  Commented = 'COMMENTED',
  Approved = 'APPROVED',
  ChangesRequested = 'CHANGES_REQUESTED',
  Dismissed = 'DISMISSED',
}

export interface PostedReview {
  id: string;
  url: string;
  state: ReviewState;
}

/** One round trip for everything the create needs: neither `gh pr view` nor the threads query
 *  returns the PR's node id, which the mutation takes. */
const TARGET_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id
      headRefOid
      reviews(first:20, states:[PENDING]){ nodes{ id url author{ login } } }
    }
  }
}`;

/** No `event` key anywhere, which is what leaves the review PENDING. Do not add one. */
const CREATE_MUTATION = `mutation($pullRequestId:ID!,$commitOID:GitObjectID!,$body:String!,$threads:[DraftPullRequestReviewThread!]!){
  addPullRequestReview(input:{pullRequestId:$pullRequestId,commitOID:$commitOID,body:$body,threads:$threads}){
    pullRequestReview{ id url state }
  }
}`;

const DELETE_MUTATION = `mutation($reviewId:ID!){
  deletePullRequestReview(input:{pullRequestReviewId:$reviewId}){ pullRequestReview{ id } }
}`;

export interface CreateReviewVars {
  pullRequestId: string;
  commitOID: string;
  body: string;
  threads: readonly DraftThread[];
}

/** The `--input -` body for the create. Built here so the absent `event` key is unit-testable. */
export function createReviewRequest(vars: CreateReviewVars): string {
  return JSON.stringify({ query: CREATE_MUTATION, variables: vars });
}

interface TargetResponse {
  data?: {
    viewer?: { login?: string };
    repository?: {
      pullRequest?: {
        id?: string;
        headRefOid?: string;
        reviews?: { nodes?: ({ id?: string; url?: string; author?: { login?: string } | null } | null)[] };
      } | null;
    } | null;
  };
}

/** Parse the target query. Split from the call so the shape this depends on needs no round trip. */
export function parsePendingReviewTarget(json: string): PendingReviewTarget {
  const data = (JSON.parse(json) as TargetResponse).data;
  const pr = data?.repository?.pullRequest;
  if (!pr) {
    throw new Error('GitHub returned no pull request for that repo and number.');
  }
  if (typeof pr.id !== 'string' || typeof pr.headRefOid !== 'string') {
    throw new Error('GitHub returned a pull request with no id or head ref.');
  }
  const login = data?.viewer?.login;
  // Another user's draft is invisible to us anyway; filtering by author keeps that from being load-bearing.
  const mine = (pr.reviews?.nodes ?? []).find(
    (n) => n && typeof n.id === 'string' && typeof n.url === 'string' && n.author?.login === login,
  );
  return {
    pullRequestId: pr.id,
    headOid: pr.headRefOid,
    ...(mine ? { pending: { id: mine.id as string, url: mine.url as string } } : {}),
  };
}

interface CreateResponse {
  data?: { addPullRequestReview?: { pullRequestReview?: { id?: string; url?: string; state?: string } | null } | null };
}

/**
 * Parse the create response, refusing anything but a draft. A review that came back `COMMENTED`
 * means pr-open published to the PR author, which is the one outcome this feature exists to prevent,
 * so it is an error here rather than a state the caller has to remember to check.
 */
export function parseCreatedReview(json: string): PostedReview {
  const review = (JSON.parse(json) as CreateResponse).data?.addPullRequestReview?.pullRequestReview;
  if (!review || typeof review.id !== 'string' || typeof review.url !== 'string') {
    throw new Error('GitHub accepted the review but returned no review to show.');
  }
  if (review.state !== ReviewState.Pending) {
    throw new Error(`GitHub created the review as ${review.state ?? 'an unknown state'} rather than a pending draft.`);
  }
  return { id: review.id, url: review.url, state: ReviewState.Pending };
}

export async function fetchPendingReviewTarget(dir: string, pr: OwnedPrRef): Promise<PendingReviewTarget> {
  const out = await runGh(
    ['api', 'graphql', '-f', `query=${TARGET_QUERY}`, '-f', `owner=${pr.owner}`, '-f', `name=${pr.repo}`, '-F', `number=${pr.number}`],
    dir,
  );
  return parsePendingReviewTarget(out);
}

/** Create the draft. One call carrying every comment, so it lands whole or not at all. */
export async function createPendingReview(
  dir: string,
  vars: CreateReviewVars,
  signal?: AbortSignal,
): Promise<PostedReview> {
  const out = await runGh(['api', 'graphql', '--input', '-'], dir, { input: createReviewRequest(vars), signal });
  return parseCreatedReview(out);
}

/** Discard a draft. Only ever called on one the user chose to replace. */
export async function deletePendingReview(dir: string, reviewId: string): Promise<void> {
  await runGh(['api', 'graphql', '-f', `query=${DELETE_MUTATION}`, '-f', `reviewId=${reviewId}`], dir);
}
