# Multi-PR Explorer

A VS Code extension that lists open pull/merge requests **and assigned
issues / tickets / work items** across **GitHub**, **GitLab**,
**Bitbucket Cloud**, and **Azure DevOps** in a single tree view.
Multi-account per provider; tokens stored in VS Code's `SecretStorage`.

## Features

- One sidebar view (Activity Bar → Pull Requests) grouped as
  **account → (Pull Requests | Issues) → repo → item**.
- Per-provider authentication, multiple accounts of the same kind supported.
- Click a row to open the PR/MR/issue in your default browser.
- Self-hosted **GitLab** and **GitHub Enterprise** by URL; cloud **Bitbucket**
  and **Azure DevOps**.
- Add-Account prompts stay open when you alt-tab to grab a token
  (`ignoreFocusOut`).
- Manual `Refresh` (no auto-poll, intentionally — reduces API noise).

## Install / run

### Dev mode (recommended for first run)

```powershell
cd multi-pr-explorer
npm install
npm run compile
```

Then in VS Code, press **F5** to launch an Extension Development Host with this
extension loaded. The view appears in the Activity Bar.

### Build a redistributable VSIX

```powershell
npm run package
```

That produces `multi-pr-explorer-0.1.0.vsix`. Install via
*Extensions → … → Install from VSIX…*.

## Add an account

Click **`+`** in the view title bar (or run *Multi-PR: Add Account*) and follow
the prompts:

| Provider          | Base URL                              | Extra needed | Token type |
|-------------------|---------------------------------------|--------------|------------|
| GitHub            | `https://github.com` or GHE URL       | —            | PAT, `repo` read |
| GitLab            | `https://gitlab.com` or self-hosted   | —            | PAT, `read_api`  |
| Bitbucket Cloud   | `https://api.bitbucket.org`           | workspace    | `username:apppassword` or `email:apitoken` |
| Azure DevOps      | `https://dev.azure.com`               | organization | PAT, *Code: Read* |

Tokens are written only to VS Code's `SecretStorage`. Account metadata
(label, kind, base URL, extras) lives in your settings under
`multiPrExplorer.accounts`.

## What each provider returns

### Pull / Merge Requests

- **GitHub** — PRs the authenticated user **authored** *or* has been
  **review-requested** on (deduped). Cross-org via `/search/issues`.
- **GitLab** — MRs created by you *or* assigned to you (`scope=created_by_me`
  + `scope=assigned_to_me`). Works on cloud and self-hosted.
- **Bitbucket Cloud** — All open PRs across repos in the configured
  workspace where you have `member` access. Capped at 50 repos per refresh.
- **Azure DevOps** — All `active` PRs in the configured organization.

### Issues / Tickets / Work Items (assigned to me)

- **GitHub** — `/issues?filter=assigned&state=open` across all visible repos,
  with PRs filtered out (GitHub's `/issues` returns both — we drop entries
  that have a `pull_request` field).
- **GitLab** — `/api/v4/issues?scope=assigned_to_me&state=opened`. Cloud and
  self-hosted.
- **Bitbucket Cloud** — Not implemented in v0.2. Bitbucket issues are per-repo
  and most workspaces don't enable them; cross-workspace "assigned to me"
  would mean enumerating every repo's tracker. Returns empty.
- **Azure DevOps** — Two-step WIQL query:
  `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND
  [System.State] NOT IN ('Closed','Done','Removed','Resolved')`, then a batch
  GET to fill in title / type / project. Capped at 100 items.

## Limitations (v0.2)

- Bitbucket **Server** (self-hosted Stash) and Azure DevOps **Server** are
  not supported — different APIs, different auth.
- Bitbucket Cloud issues not listed (see above).
- No in-editor diff/review. Click row → opens in browser.
- No filters / no auto-refresh / no notifications.
- Manual cache invalidation via `Refresh`.

## License

MIT.
