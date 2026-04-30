# Multi-PR Explorer

A VS Code extension that lists open pull/merge requests and assigned
issues/tickets/work items for **the git repos open in your current VS Code
window**, across **GitHub**, **GitLab**, **Bitbucket Cloud**, and
**Azure DevOps**.

Multi-account per provider; tokens stored in VS Code's `SecretStorage`.

## How it works (workspace-scoped, since v0.3)

1. The extension reads `vscode.workspace.workspaceFolders` and runs
   `git config --get remote.origin.url` in each folder.
2. For every detected remote, it tries each configured account's URL parser
   to find a match.
3. For matching repo/account pairs, it fetches **all open PRs** in the repo
   plus **issues/work items assigned to you** in the repo (or project, for ADO).

Anything outside your open workspace is **not fetched**. Open a different
folder → different list. Add/remove a workspace folder → tree auto-refreshes.

## Tree layout

```
[repo] owner/my-project                    ← one node per workspace repo
  Pull Requests (3)
    #14  Refactor auth                    Alice  •  2h ago
    #12  Bump deps                        Bob    •  1d ago
  Issues / Tickets (1)
    #99  Memory leak in worker            you    •  3h ago
[repo] another-team/some-service
  ...
[unmatched] disconnected-folder            ← tooltip shows the remote URL
```

## Install / run

### Dev mode

```powershell
cd multi-pr-explorer
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host.

### Build a redistributable VSIX

```powershell
npm run package
```

That produces `multi-pr-explorer-0.3.0.vsix`. Install via
*Extensions → … → Install from VSIX…* or:

```powershell
code --install-extension multi-pr-explorer-0.3.0.vsix
```

## Add an account

Click **`+`** in the view title bar. Prompts use `ignoreFocusOut`, so you can
alt-tab to a browser to grab a token and the prompt will still be there.

| Provider          | Base URL                              | Extra needed | Token type |
|-------------------|---------------------------------------|--------------|------------|
| GitHub            | `https://github.com` or GHE URL       | —            | PAT, `repo` read |
| GitLab            | `https://gitlab.com` or self-hosted   | —            | PAT, `read_api`  |
| Bitbucket Cloud   | `https://api.bitbucket.org`           | —            | `username:apppassword` or `email:apitoken` |
| Azure DevOps      | `https://dev.azure.com`               | organization | PAT, *Code: Read* + *Work Items: Read* |

Account metadata (label, kind, base URL, extras) lives in your settings under
`multiPrExplorer.accounts`. Tokens are written only to `SecretStorage` and
never appear in settings.

## What gets queried per workspace repo

| Provider | PRs in repo | Issues / tickets in repo |
|---|---|---|
| GitHub  | `GET /repos/{owner}/{repo}/pulls?state=open` | `GET /repos/{owner}/{repo}/issues?state=open&assignee=*` (PRs filtered out via the `pull_request` field) |
| GitLab  | `GET /api/v4/projects/{path}/merge_requests?state=opened` | `GET /api/v4/projects/{path}/issues?state=opened&scope=assigned_to_me` |
| Bitbucket | `GET /2.0/repositories/{ws}/{repo}/pullrequests?state=OPEN` | `GET /2.0/repositories/{ws}/{repo}/issues?status=new&status=open` (404 ⇒ issues disabled, treated as empty) |
| Azure DevOps | `GET /{org}/{project}/_apis/git/repositories/{repo}/pullrequests?searchCriteria.status=active` | WIQL: `[System.TeamProject] = '{project}' AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed','Done','Removed','Resolved')` then batch GET `/_apis/wit/workitems` |

Multiple workspace folders for the same ADO project will deduplicate at the
project level for the issues query (assigned to me in the project) but each
ADO repo gets its own PR fetch.

## Limitations (v0.3)

- Bitbucket **Server** (self-hosted Stash) and Azure DevOps **Server** are not
  supported — different APIs, different auth.
- No in-editor diff/review. Click row → opens in browser.
- No filters / no auto-refresh / no notifications. Manual cache invalidation
  via `Refresh`.
- Workspace folder must have an `origin` remote pointing at a host that maps
  to a configured account; otherwise it shows under "unmatched".

## License

MIT.
