import { Account, ProviderClient, PullItem, RepoRef } from "./types";

interface PullRequestItem {
    number: number;
    title: string;
    user: { login: string };
    updated_at: string;
    html_url: string;
    draft?: boolean;
}

interface IssueItem {
    number: number;
    title: string;
    user: { login: string };
    assignees?: { login: string }[];
    updated_at: string;
    html_url: string;
    pull_request?: unknown;
}

function apiBase(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const host = trimmed.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (host === "github.com") {
        return "https://api.github.com";
    }
    return `${trimmed}/api/v3`;
}

function hostOf(baseUrl: string): string {
    return baseUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

function parseUrl(url: string): { host: string; owner: string; repo: string } | null {
    let s = url.replace(/\.git$/, "").replace(/\/+$/, "");
    let host: string, path: string;
    let m = s.match(/^https?:\/\/([^/]+)\/(.+)$/i);
    if (m) {
        host = m[1].toLowerCase();
        path = m[2];
    } else {
        m = s.match(/^[^@]+@([^:]+):(.+)$/);
        if (!m) return null;
        host = m[1].toLowerCase();
        path = m[2];
    }
    const parts = path.split("/").filter(p => p.length > 0);
    if (parts.length < 2) return null;
    // GitHub repos are always exactly owner/repo — anything deeper isn't ours.
    if (parts.length !== 2) return null;
    return { host, owner: parts[0], repo: parts[1] };
}

export class GitHubClient implements ProviderClient {
    parseRepoUrl(url: string, account: Account): RepoRef | null {
        const accHost = hostOf(account.baseUrl);
        const parsed = parseUrl(url);
        if (!parsed) return null;
        if (parsed.host !== accHost) return null;
        return {
            url,
            displayName: `${parsed.owner}/${parsed.repo}`,
            path: { owner: parsed.owner, repo: parsed.repo },
        };
    }

    private headers(token: string): Record<string, string> {
        return {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "multi-pr-explorer",
        };
    }

    async listPullRequests(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const api = apiBase(account.baseUrl);
        const url = `${api}/repos/${repo.path.owner}/${repo.path.repo}/pulls?state=open&per_page=100`;
        const res = await fetch(url, { headers: this.headers(token) });
        if (!res.ok) {
            throw new Error(`GitHub PRs ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as PullRequestItem[];
        return data.map(pr => ({
            id: `#${pr.number}`,
            title: pr.title,
            author: pr.user.login,
            repo: repo.displayName,
            updated: pr.updated_at,
            url: pr.html_url,
            draft: pr.draft === true,
        }));
    }

    async listIssues(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const api = apiBase(account.baseUrl);
        // /issues returns both issues and PRs; filter to issues only via pull_request key.
        // assignee=* picks issues with at least one assignee; without it we'd only get
        // issues with author scope. Use 'assignee=@me' equivalent via assignee=<authenticated user>.
        // GitHub doesn't support @me in this endpoint, but assignee=* + filter client-side is fine
        // for a single repo. We'll bias toward "any assigned issue in this repo".
        const url = `${api}/repos/${repo.path.owner}/${repo.path.repo}/issues?state=open&assignee=*&per_page=100`;
        const res = await fetch(url, { headers: this.headers(token) });
        if (!res.ok) {
            throw new Error(`GitHub issues ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as IssueItem[];
        return data
            .filter(e => !e.pull_request)
            .map(e => ({
                id: `#${e.number}`,
                title: e.title,
                author: e.assignees?.[0]?.login ?? e.user.login,
                repo: repo.displayName,
                updated: e.updated_at,
                url: e.html_url,
            }));
    }
}
