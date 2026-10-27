# PR Open

Open any GitHub PR in its local clone and hand off to the **GitHub Pull Requests** extension
for native review + inline commenting.

- Side panel (activity bar): paste a PR URL, or type/pick a repo + number, with PR page / Diff
  actions and an open-PR list.
- Commands: `PR Open: Open Pull Request by URL`, `... by Repo + Number`.
- URI handler `vscode://andrewcho.pr-open/open?url=<PR url>&action=page|diff|checkout`.

## Setup

Requires the `GitHub.vscode-pull-request-github` extension (v0.158.0+).

Configure your clone roots (required, validated on load):

```json
"prOpen.searchRoots": ["~/dev"],
"prOpen.cloneRoot": "~/dev"
```

A PR for `owner/repo` resolves to `<root>/<repo>`, matched by repo name. If no clone is
found, you're offered to clone into `cloneRoot`.
