# Multi-PR Explorer

One VS Code panel that shows the open pull/merge requests and the issues
assigned to you for the **git repos open in your current window**, across
**GitHub**, **GitLab**, **Bitbucket Cloud**, and **Azure DevOps**.

No fetching for repos outside your workspace, no broad cross-account search,
no extra noise.

---

## Quick start

1. **Install** the extension:
   ```powershell
   code --install-extension multi-pr-explorer-0.3.0.vsix
   ```
   Or press **F5** from the source folder for a dev-host run.
2. Reload VS Code, then click the **Pull Requests** icon in the Activity Bar
   on the left.
3. Click the **+** in the panel title bar → pick a provider → fill in label,
   base URL, (optional workspace/organization), and paste a token.
4. Open a folder/workspace whose remote points at one of your accounts'
   hosts. The tree populates automatically.
5. Click any PR or issue row → opens in your default browser.

The panel auto-refreshes when you add or remove workspace folders. Manual
refresh: **circle-arrow** icon in the panel title bar.

---

## Generating tokens

Each provider's "token" is just a Personal Access Token (or equivalent).
Once a token is in `SecretStorage`, the extension never echoes it back —
remove + re-add the account if you need to rotate.

### GitHub (cloud or Enterprise)

1. Visit **<https://github.com/settings/tokens>** (cloud) or
   `https://YOUR-GHE-HOST/settings/tokens` (Enterprise).
2. *Generate new token (classic)* or *Fine-grained tokens*.
3. Required scopes:
   - **Classic**: `repo` (full read), `read:org` if you need org repos.
   - **Fine-grained**: select your repos, then *Repository permissions →
     Pull requests: Read* and *Issues: Read*.
4. Copy the token (`ghp_…` or `github_pat_…`) → paste when prompted.
5. **Base URL**: `https://github.com` for cloud, or your full Enterprise
   URL like `https://github.acme.com`.

### GitLab (cloud or self-hosted)

1. Visit **<https://gitlab.com/-/user_settings/personal_access_tokens>** or
   `https://YOUR-GITLAB/-/user_settings/personal_access_tokens`.
2. *Add new token*.
3. Required scopes: **`read_api`** (or `api` if you also use this token
   elsewhere).
4. Copy the token (`glpat-…`) → paste when prompted.
5. **Base URL**: `https://gitlab.com` or your self-hosted URL.

### Bitbucket Cloud

The extension uses Basic auth. Two options:

- **App Password** (legacy but widely supported): generate at
  **<https://bitbucket.org/account/settings/app-passwords/>**. Required
  permissions: *Pull requests: Read*, *Issues: Read* (if used),
  *Repositories: Read*. Paste as `your-bitbucket-username:apppassword`.
- **API Token** (newer Atlassian-wide): generate at
  **<https://id.atlassian.com/manage-profile/security/api-tokens>**. Paste
  as `your-email@example.com:apitoken`.

The extension always talks to `https://api.bitbucket.org` regardless of what
you put in the **Base URL** field, so the default is fine.

When prompted for a **workspace**, enter the slug from your Bitbucket URL
(`bitbucket.org/{workspace}/{repo}`).

### Azure DevOps

1. Visit **<https://dev.azure.com/YOUR-ORG/_usersSettings/tokens>** (replace
   `YOUR-ORG` with your organization slug).
2. *New Token*.
3. Required scopes: **Code: Read** (for PRs) + **Work Items: Read** (for
   tickets). Set an expiration that works for you.
4. Copy the token → paste when prompted.
5. **Base URL**: `https://dev.azure.com`.
6. **Organization**: the slug from your Azure DevOps URL
   (`dev.azure.com/{organization}`).

---

## Mixing providers (GitLab code + Azure DevOps tickets)

Common setup: code lives on GitLab (so PRs/MRs come from there) but tickets
live in Azure DevOps Boards.

### Easy way — UI wizard (v0.5+)

1. Add both accounts — one GitLab, one Azure DevOps.
2. Open a workspace folder cloned from your GitLab. The repo appears in the
   tree.
3. **Right-click the repo node → *Map Issue Tracker…***
   (or run **Multi-PR: Map Issue Tracker…** from the command palette).
4. The wizard walks you through:
   - Scope: *just this repo* vs *all repos at this host*.
   - Account: pick the Azure DevOps account.
   - Project: a list of your ADO projects is fetched automatically and
     shown as a quickpick. If the API call fails (e.g. token can't list
     projects), it falls back to a manual input.
5. Done. The repo node's description shows `issues→Work ADO` and the
   tree refreshes.

To remove or edit overrides later, run **Multi-PR: Manage Issue Tracker
Overrides…** (or use the view title's *…* menu).

### Manual way — `settings.json`

The wizard writes the same shape; you can edit it by hand if you prefer:

```jsonc
"multiPrExplorer.issueTrackerMap": [
  {
    "matches": "gitlab.acme.com",        // case-insensitive substring of the remote URL
    "account": "Work ADO",                // account label or id
    "project": "Backend"                  // ADO Team Project (required for azure)
  }
]
```

Multiple overrides are supported. The first matching entry wins, so put
more specific patterns above broader ones.

If the override target can't be resolved (typo in `account`, missing
`project`), the tree falls back to using the same account for issues as for
PRs and the `issues→` tag isn't shown.

## Day-to-day use

### Looking at one repo

Open the folder in VS Code → wait a beat → the matching repo shows up in
the tree with two subsections: *Pull Requests* and *Issues / Tickets*. Click
any row to open it in the browser.

### Looking at several repos

Use a multi-root workspace. *File → Add Folder to Workspace…* — every git
folder you add becomes a top-level node in the tree. Saves to a `.code-workspace`
file you can reopen later.

### Switching accounts (e.g. work vs personal GitHub)

Add both as separate accounts (different labels, same provider, same or
different base URL). When the extension sees a workspace remote, it tries
each configured account in order and uses the first one whose URL parser
matches. For two accounts on the same host, that means the order of accounts
in your settings controls which one is used — edit
`multiPrExplorer.accounts` directly in `settings.json` to reorder.

### Refreshing

Manual: click the refresh icon in the panel header. Automatic: the tree
re-fetches whenever workspace folders change or whenever the account list
changes.

For periodic auto-refresh, set:
```json
"multiPrExplorer.refreshIntervalMinutes": 10
```
`0` (default) disables it.

### Right-click actions

- **On a repo node:** *Open Repo in Browser* — opens the repo's web page.
- **On a PR/issue row:** *Open in Browser* (also fires on click) and *Copy URL*.

### Removing an account

Run *Multi-PR: Remove Account…* from the Command Palette (Ctrl+Shift+P) or
the panel title bar. The token is deleted from `SecretStorage`.

---

## Tree layout

```
[repo] owner/my-project                    ← one node per workspace repo
  Pull Requests (3)
    #14  Refactor auth                    Alice  •  2h ago
    #12  Bump deps                        Bob    •  1d ago
    #11  …                                Carol  •  5d ago
  Issues / Tickets (1)
    #99  Memory leak in worker            you    •  3h ago
[repo] another-team/some-service
  Pull Requests (0)
    No open PRs.
  Issues / Tickets (0)
    No assigned issues.
[unmatched] disconnected-folder            ← tooltip shows the remote URL
```

- **Workspace folder names** vs. tree labels: the tree shows the
  provider-side display name (`owner/repo` for GitHub, `org/project/repo`
  for ADO, full path for GitLab nested groups), not the local folder name.
  The folder name appears in the tooltip.
- **Sorted within each section** by `updated` (most recent first).
- **Errors** show as red × items inline — e.g. `403 Forbidden` if your token
  lacks scope for that repo.

---

## Troubleshooting

**Tree is empty even though I added an account.**
You need a workspace folder whose `origin` remote matches one of your
configured accounts' hosts. Check:
```powershell
git -C path\to\folder config --get remote.origin.url
```
The host of that URL must match the host of your account's *Base URL* (e.g.
`github.com` ↔ `https://github.com`). The output of *Multi-PR: Refresh* will
classify each folder as a matched repo, an unmatched folder (yellow warning
icon), or skipped (not a git repo).

**My folder shows as "unmatched".**
Click it — the tooltip shows the remote URL. Add an account whose base URL
matches that host and refresh.

**Issues section is empty even though I have assigned issues.**
- GitHub: confirm your token has `Issues: Read` (fine-grained) or `repo`
  (classic). The query is `assignee=*` per-repo, so issues without an
  assignee won't appear here by design.
- GitLab: confirm `read_api` scope; the query is
  `scope=assigned_to_me&state=opened`.
- Azure DevOps: confirm *Work Items: Read* scope. The WIQL query is
  per-project; make sure `[System.AssignedTo] = @Me` resolves to you.
- Bitbucket Cloud: per-repo issues only show up if issue tracking is
  enabled on that repo.

**Same PR shows twice for one repo.**
Shouldn't happen with v0.3 (per-repo queries) — open an issue with the URL
and your provider's response if you see it.

**Token revoked / 401 / 403.**
Remove the account, generate a new token, re-add. There's no in-place token
update yet.

**Where's my token stored?**
`vscode.SecretStorage`, keyed by `multiPrExplorer.token.<account-id>`. Not
in settings, not in the workspace, not on disk in plaintext. The
*Remove Account* command also deletes the secret.

---

## Reference: what's queried per workspace repo

| Provider     | Pull requests                                                                              | Issues / tickets                                                                                     |
|---|---|---|
| GitHub       | `GET /repos/{owner}/{repo}/pulls?state=open`                                               | `GET /repos/{owner}/{repo}/issues?state=open&assignee=*` (PRs filtered out via `pull_request` field) |
| GitLab       | `GET /api/v4/projects/{path}/merge_requests?state=opened`                                   | `GET /api/v4/projects/{path}/issues?state=opened&scope=assigned_to_me`                                |
| Bitbucket    | `GET /2.0/repositories/{ws}/{repo}/pullrequests?state=OPEN`                                 | `GET /2.0/repositories/{ws}/{repo}/issues?status=new&status=open` (404 ⇒ tracker disabled, empty)    |
| Azure DevOps | `GET /{org}/{project}/_apis/git/repositories/{repo}/pullrequests?searchCriteria.status=active` | WIQL `[System.TeamProject] = '{project}' AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed','Done','Removed','Resolved')` then batch GET `/_apis/wit/workitems` |

---

## Build from source

```powershell
git clone https://github.com/vpatel071997/multi-pr-explorer.git
cd multi-pr-explorer
npm install
npm run compile      # plain tsc -> out/
npm run package      # produces multi-pr-explorer-X.Y.Z.vsix
```

Press **F5** in VS Code to launch the Extension Development Host with the
extension loaded — useful for iterating without packaging.

---

## Limitations (v0.5)

- Bitbucket **Server** (self-hosted Stash) and Azure DevOps **Server** are
  not supported — different APIs, different auth.
- No in-editor diff/review. Click row → opens in browser.
- No filters / no auto-poll / no notifications.
- Workspace folder must have an `origin` remote pointing at a host that
  maps to a configured account; otherwise it shows under "unmatched".
- One token per account. To switch tokens, remove and re-add the account.

## License

MIT.
