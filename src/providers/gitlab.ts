import { Account, ProviderClient, PullItem, RepoRef, RepoWebUrls, TokenStatus } from "./types";
import { probe, describeProbe } from "./http";

interface User { username: string; }

interface MergeRequest {
    iid: number;
    title: string;
    author: User;
    assignees?: User[];
    reviewers?: User[];
    updated_at: string;
    web_url: string;
    draft?: boolean;
    work_in_progress?: boolean;
}

interface Issue {
    iid: number;
    title: string;
    author: { username: string };
    assignees?: { username: string }[];
    updated_at: string;
    web_url: string;
}

function hostOf(baseUrl: string): string {
    return baseUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

function parseUrl(url: string): { host: string; path: string; repo: string } | null {
    let s = url.replace(/\.git$/, "").replace(/\/+$/, "");
    let host: string, body: string;
    let m = s.match(/^https?:\/\/([^/]+)\/(.+)$/i);
    if (m) {
        host = m[1].toLowerCase();
        body = m[2];
    } else {
        m = s.match(/^[^@]+@([^:]+):(.+)$/);
        if (!m) return null;
        host = m[1].toLowerCase();
        body = m[2];
    }
    const parts = body.split("/").filter(p => p.length > 0);
    if (parts.length < 2) return null;
    return { host, path: parts.join("/"), repo: parts[parts.length - 1] };
}

export class GitLabClient implements ProviderClient {
    /** authenticated username per accountId; populated by verifyToken. */
    private usernameByAccount = new Map<string, string>();

    parseRepoUrl(url: string, account: Account): RepoRef | null {
        const accHost = hostOf(account.baseUrl);
        const parsed = parseUrl(url);
        if (!parsed) return null;
        if (parsed.host !== accHost) return null;
        return {
            url,
            displayName: parsed.path,
            path: { fullPath: parsed.path, repo: parsed.repo },
        };
    }

    private headers(token: string): Record<string, string> {
        return { "PRIVATE-TOKEN": token };
    }

    async verifyToken(account: Account, token: string): Promise<TokenStatus> {
        const url = `${account.baseUrl.replace(/\/+$/, "")}/api/v4/user`;
        const p = await probe(url, this.headers(token));
        if (!p.ok) {
            return { ok: false, error: describeProbe(p, url) };
        }
        try {
            const data = JSON.parse(p.bodyText ?? "{}") as { username?: string };
            const username = data.username ?? "?";
            if (data.username) {
                this.usernameByAccount.set(account.id, data.username);
            }
            return { ok: true, user: username };
        } catch {
            return { ok: false, error: `bad JSON from ${url}` };
        }
    }

    async listPullRequests(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = account.baseUrl.replace(/\/+$/, "");
        const id = encodeURIComponent(repo.path.fullPath);
        const url = `${base}/api/v4/projects/${id}/merge_requests?state=opened&per_page=100`;
        const res = await fetch(url, { headers: this.headers(token) });
        if (!res.ok) {
            throw new Error(`GitLab MRs ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as MergeRequest[];
        const me = this.usernameByAccount.get(account.id);
        const filtered = me
            ? data.filter(mr =>
                mr.author.username === me ||
                mr.assignees?.some(a => a.username === me) ||
                mr.reviewers?.some(r => r.username === me))
            : data;
        return filtered.map(mr => ({
            id: `!${mr.iid}`,
            title: mr.title,
            author: mr.author.username,
            repo: repo.displayName,
            updated: mr.updated_at,
            url: mr.web_url,
            // GitLab renamed work_in_progress to draft a few releases back; keep both.
            draft: mr.draft === true || mr.work_in_progress === true,
        }));
    }

    async listIssues(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = account.baseUrl.replace(/\/+$/, "");
        const id = encodeURIComponent(repo.path.fullPath);
        const url = `${base}/api/v4/projects/${id}/issues?state=opened&scope=assigned_to_me&per_page=100`;
        const res = await fetch(url, { headers: this.headers(token) });
        if (!res.ok) {
            throw new Error(`GitLab issues ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as Issue[];
        return data.map(i => ({
            id: `#${i.iid}`,
            title: i.title,
            author: i.assignees?.[0]?.username ?? i.author.username,
            repo: repo.displayName,
            updated: i.updated_at,
            url: i.web_url,
        }));
    }

    repoWebUrls(account: Account, repo: RepoRef): RepoWebUrls {
        const base = account.baseUrl.replace(/\/+$/, "");
        const r = `${base}/${repo.path.fullPath}`;
        const me = this.usernameByAccount.get(account.id);
        const mineQ = me ? `?state=opened&assignee_username=${encodeURIComponent(me)}` : `?state=opened`;
        return {
            myPrs: `${r}/-/merge_requests${mineQ}`,
            allPrs: `${r}/-/merge_requests?state=opened`,
            newPr: `${r}/-/merge_requests/new`,
            myIssues: `${r}/-/issues${mineQ}`,
            allIssues: `${r}/-/issues?state=opened`,
            newIssue: `${r}/-/issues/new`,
        };
    }
}
