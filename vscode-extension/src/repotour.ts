import * as path from 'path';

/** Characters of file listing a repo tour's input carries. The model has Glob and Grep for the rest,
 *  so the listing only has to orient it, and a bigger one buys slower first steps. */
export const REPO_TOUR_LISTING_BUDGET = 60_000;

/** Configuration files a repo tour's input lists at most; the tour must read each one. */
export const REPO_TOUR_CONFIG_LIMIT = 300;

// Build, toolchain, quality, CI/CD, runtime, container and ownership files, matched on the path.
const CONFIG_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package\.json|pnpm-workspace\.yaml|lerna\.json|nx\.json|turbo\.json|tsconfig[^/]*\.json|jsconfig\.json)$/,
  /(^|\/)(go\.mod|go\.work|Cargo\.toml|pyproject\.toml|setup\.cfg|setup\.py|requirements[^/]*\.txt|Pipfile|Gemfile|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|composer\.json|[^/]+\.csproj|mix\.exs|deno\.jsonc?|bunfig\.toml)$/,
  /(^|\/)(Makefile|justfile|Taskfile\.ya?ml|Rakefile|Earthfile|BUILD(\.bazel)?|WORKSPACE|MODULE\.bazel)$/,
  /(^|\/)(\.tool-versions|mise\.toml|\.mise\.toml|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.go-version|rust-toolchain(\.toml)?|\.sdkmanrc)$/,
  /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|prettier\.config\.[cm]?js|biome\.jsonc?|\.golangci\.ya?ml|ruff\.toml|\.ruff\.toml|mypy\.ini|\.flake8|\.pylintrc|\.rubocop\.yml|clippy\.toml|rustfmt\.toml|\.stylelintrc[^/]*|\.editorconfig|\.markdownlint[^/]*)$/,
  /(^|\/)(\.pre-commit-config\.ya?ml|prek\.toml|lefthook\.ya?ml|\.husky\/[^/]+|\.lintstagedrc[^/]*|commitlint\.config\.[cm]?js)$/,
  /(^|\/)(jest|vitest|playwright|cypress|karma)\.config\.[cm]?[jt]s$|(^|\/)(pytest\.ini|tox\.ini|noxfile\.py|\.mocharc[^/]*|\.c8rc[^/]*|\.nycrc[^/]*|codecov\.ya?ml)$/,
  /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml|dependabot\.ya?ml|CODEOWNERS|pull_request_template\.md|[^/]+\.ya?ml)$/,
  /^(\.buildkite|\.circleci|\.gitlab)\/.+\.ya?ml$|^(\.gitlab-ci\.yml|\.travis\.yml|azure-pipelines\.yml|Jenkinsfile|bitbucket-pipelines\.yml|renovate\.json5?|\.renovaterc[^/]*)$/,
  /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile|\.dockerignore|(docker-)?compose[^/]*\.ya?ml|Procfile|fly\.toml|vercel\.json|netlify\.toml|app\.ya?ml|serverless\.ya?ml|Chart\.yaml|values[^/]*\.ya?ml|skaffold\.ya?ml|kustomization\.ya?ml)$/,
  /\.(tf|tfvars|hcl)$|(^|\/)(cdk\.json|pulumi[^/]*\.ya?ml)$/,
  /(^|\/)(\.env\.(example|sample|template)|config\.(ya?ml|json|toml)|settings\.(ya?ml|json|toml)|[^/]+\.config\.[cm]?[jt]s|\.vscodeignore|\.vscode\/[^/]+\.json)$/,
  /(^|\/)(CODEOWNERS|OWNERS|CONTRIBUTING\.md|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.cursorrules|\.gitattributes|\.gitmodules)$/,
];

/** The tracked files that configure how the repository is built, checked, run, shipped or owned. */
export function configFiles(files: readonly string[]): string[] {
  return files.filter((file) => CONFIG_PATTERNS.some((pattern) => pattern.test(file)));
}

function configSection(files: readonly string[]): string[] {
  const found = configFiles(files);
  const shown = found.slice(0, REPO_TOUR_CONFIG_LIMIT);
  const lines = ['', '### CONFIGURATION FILES (read each one that bears on the tour)'];
  if (found.length === 0) {
    return [...lines, 'None matched by name; look for configuration with Glob and Grep.'];
  }
  lines.push(...shown);
  if (found.length > shown.length) {
    lines.push(`... ${found.length - shown.length} more; use Glob to find them.`);
  }
  return lines;
}

/**
 * The repo tour's input: the repo's name, an orienting listing of what HEAD tracks, and the
 * configuration files the tour must cover.
 *
 * Every path when they fit the budget. Otherwise one line per directory with its file count, which
 * keeps a repo that vendors tens of thousands of files to a map the model can read in one pass; the
 * directories are cut at the budget as a last resort, with a line saying how many were left out.
 */
export function repoTourPayload(repo: string, files: readonly string[]): string {
  const header = [`### REPOSITORY ${repo}`, `HEAD tracks ${files.length} files.`, ''];
  const all = files.join('\n');
  if (all.length <= REPO_TOUR_LISTING_BUDGET) {
    return [...header, '### TRACKED FILES', all, ...configSection(files)].join('\n');
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const lines: string[] = [];
  let length = 0;
  for (const [dir, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const line = `${dir}/ (${n} files)`;
    if (length + line.length + 1 > REPO_TOUR_LISTING_BUDGET) {
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (lines.length < counts.size) {
    lines.push(`... ${counts.size - lines.length} more directories; use Glob to list them.`);
  }
  return [
    ...header,
    '### TRACKED DIRECTORIES (too many files to list; use Glob to see inside one)',
    ...lines,
    ...configSection(files),
  ].join('\n');
}
