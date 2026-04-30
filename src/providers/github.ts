import { Account, ProviderClient, PullItem, RepoRef, RepoWebUrls, TokenStatus } from "./types";
import { probe, describeProbe } from "./http";

interface User { login: string; }

interface PullRequestItem {
    number: number;
    title: string;
    user: User;
    updated_at: string;
    html_url: string;
    draft?: boolean;
    requested_reviewers?: User[];
    assignees?: User[];
}

interface SearchIssueItem {
    number: number;
    title: string;
    user: { login: string };
    assignees?: { login: string }[];
    updated_at: string;
    html_url: string;
}

interface SearchResponse {
    total_count: number;
    items: SearchIssueItem[];
}

/**
 * Resolve the GitHub REST API root from the user-configured baseUrl.
 *
 *   github.com             → api.github.com           (cloud quirk: separate host)
 *   ghe.acme.com           → ghe.acme.com/api/v3      (Enterprise, same host)
 *   api.github.com         → as-is                    (user explicitly set the API URL)
 *   anything ending /api/* → as-is                    (user gave full API path)
 */
function apiBase(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (/\/api\/v\d+$/i.test(trimmed)) {
        return trimmed;
    }
    const host = trimmed.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (host === "api.github.com") {
        return trimmed;
    }
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

/**
 * Web URL host derived from baseUrl. cloud github.com stays as-is; Enterprise
 * uses the host portion of baseUrl (so api.* and /api/v3 suffixes get stripped).
 */
function webHost(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/api\/v\d+$/i, "");
    const host = trimmed.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (host === "api.github.com") {
        return "https://github.com";
    }
    return `https://${host}`;
}

export class GitHubClient implements ProviderClient {
    /** authenticated login per accountId; populated by verifyToken. */
    private loginByAccount = new Map<string, string>();

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

    async verifyToken(account: Account, token: string): Promise<TokenStatus> {
        const url = `${apiBase(account.baseUrl)}/user`;
        const p = await probe(url, this.headers(token));
        if (!p.ok) {
            return { ok: false, error: describeProbe(p, url) };
        }
        try {
            const data = JSON.parse(p.bodyText ?? "{}") as { login?: string };
            const login = data.login ?? "?";
            if (data.login) {
                this.loginByAccount.set(account.id, data.login);
            }
            return { ok: true, user: login };
        } catch {
            return { ok: false, error: `bad JSON from ${url}` };
        }
    }

    async listPullRequests(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const api = apiBase(account.baseUrl);
        // The /pulls endpoint includes user, requested_reviewers, and assignees
        // by default — enough to filter to the authenticated user without an
        // extra round trip and without losing the `draft` field that /search
        // doesn't return.
        const url = `${api}/repos/${repo.path.owner}/${repo.path.repo}/pulls?state=open&per_page=100`;
        const res = await fetch(url, { headers: this.headers(token) });
        if (!res.ok) {
            throw new Error(`GitHub PRs ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as PullRequestItem[];
        const me = this.loginByAccount.get(account.id);
        const filtered = me
            ? data.filter(pr =>
                pr.user.login === me ||
                pr.requested_reviewers?.some(r => r.login === me) ||
                pr.assignees?.some(a => a.login === me))
            : data;
        return filtered.map(pr => ({
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
        // /search/issues with `assignee:@me` resolves the authenticated user
        // server-side and excludes PRs via `is:issue` (GitHub treats PRs as
        // a kind of issue under /repos/.../issues, so we'd otherwise have
        // to filter the pull_request marker client-side).
        const q = `is:issue is:open assignee:@me repo:${repo.path.owner}/${repo.path.repo}`;
        const url = `${api}/search/issues?q=${encodeURIComponent(q)}&per_page=100`;
        const res = await fetch(url, { headers: this.headers(token) });
        if (!res.ok) {
            throw new Error(`GitHub issues ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as SearchResponse;
        return data.items.map(it => ({
            id: `#${it.number}`,
            title: it.title,
            author: it.assignees?.[0]?.login ?? it.user.login,
            repo: repo.displayName,
            updated: it.updated_at,
            url: it.html_url,
        }));
    }

    repoWebUrls(account: Account, repo: RepoRef): RepoWebUrls {
        const host = webHost(account.baseUrl);
        const r = `${host}/${repo.path.owner}/${repo.path.repo}`;
        const prFilterMine = encodeURIComponent("is:pr is:open author:@me OR review-requested:@me OR assignee:@me");
        const issueFilterMine = encodeURIComponent("is:issue is:open assignee:@me");
        return {
            myPrs: `${r}/pulls?q=${prFilterMine}`,
            allPrs: `${r}/pulls`,
            newPr: `${r}/compare`,
            myIssues: `${r}/issues?q=${issueFilterMine}`,
            allIssues: `${r}/issues`,
            newIssue: `${r}/issues/new`,
        };
    }
}
