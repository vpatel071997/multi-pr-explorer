import { Account, ProviderClient, PullItem, RepoRef, RepoWebUrls, TokenStatus } from "./types";
import { probe, describeProbe } from "./http";

interface BbPullRequest {
    id: number;
    title: string;
    author?: { display_name?: string; nickname?: string };
    updated_on: string;
    links: { html: { href: string } };
}

interface BbIssue {
    id: number;
    title: string;
    assignee?: { display_name?: string; nickname?: string };
    reporter?: { display_name?: string; nickname?: string };
    updated_on: string;
    links: { html: { href: string } };
}

interface BbPaged<T> {
    values: T[];
}

/**
 * Resolve the Bitbucket Cloud REST API root from the user-configured baseUrl.
 * Supports either the web URL (bitbucket.org) or the API URL
 * (api.bitbucket.org), and a custom URL for proxy / self-hosted setups.
 * Always ends with `/2.0`.
 */
function bbApiRoot(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const host = trimmed.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    // Bitbucket Cloud quirk: web at bitbucket.org but API at api.bitbucket.org.
    // Translate so users entering either URL still hit the right endpoint.
    if (host === "bitbucket.org") {
        return "https://api.bitbucket.org/2.0";
    }
    return /\/2\.0$/.test(trimmed) ? trimmed : `${trimmed}/2.0`;
}

function parseUrl(url: string): { host: string; workspace: string; repo: string } | null {
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
    if (parts.length !== 2) return null;
    return { host, workspace: parts[0], repo: parts[1] };
}

export class BitbucketClient implements ProviderClient {
    /** authenticated username per accountId; populated by verifyToken. */
    private usernameByAccount = new Map<string, string>();

    parseRepoUrl(url: string, account: Account): RepoRef | null {
        const parsed = parseUrl(url);
        if (!parsed) return null;
        // Match the host against the configured account's baseUrl, with the
        // bitbucket.org ↔ api.bitbucket.org cloud quirk handled. For self-
        // hosted setups, the user's baseUrl host is the source of truth.
        const accHost = account.baseUrl
            .replace(/^https?:\/\//i, "")
            .replace(/\/.*$/, "")
            .toLowerCase();
        const cloudPair = (accHost === "bitbucket.org" || accHost === "api.bitbucket.org");
        const matches = cloudPair
            ? (parsed.host === "bitbucket.org" || parsed.host === "api.bitbucket.org")
            : parsed.host === accHost;
        if (!matches) return null;
        return {
            url,
            displayName: `${parsed.workspace}/${parsed.repo}`,
            path: { workspace: parsed.workspace, repo: parsed.repo },
        };
    }

    private auth(token: string): string {
        return "Basic " + Buffer.from(token).toString("base64");
    }

    async verifyToken(account: Account, token: string): Promise<TokenStatus> {
        const url = `${bbApiRoot(account.baseUrl)}/user`;
        const headers = { Authorization: this.auth(token), Accept: "application/json" };
        const p = await probe(url, headers);
        if (!p.ok) {
            return { ok: false, error: describeProbe(p, url) };
        }
        try {
            const data = JSON.parse(p.bodyText ?? "{}") as { username?: string; display_name?: string; nickname?: string };
            const display = data.username ?? data.nickname ?? data.display_name ?? "?";
            if (data.username) {
                this.usernameByAccount.set(account.id, data.username);
            }
            return { ok: true, user: display };
        } catch {
            return { ok: false, error: `bad JSON from ${url}` };
        }
    }

    private async getCachedUsername(account: Account, token: string): Promise<string | null> {
        const cached = this.usernameByAccount.get(account.id);
        if (cached) { return cached; }
        // Fall back to an inline /user fetch (e.g. when listIssues runs before
        // verifyToken in some test path).
        await this.verifyToken(account, token);
        return this.usernameByAccount.get(account.id) ?? null;
    }

    async listPullRequests(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = bbApiRoot(account.baseUrl);
        // Filter server-side via BBQL to PRs where the user is the author OR a
        // reviewer. If the username isn't cached yet, fall back to all open PRs.
        const username = await this.getCachedUsername(account, token);
        const q = username
            ? `state="OPEN" AND (author.username="${username}" OR reviewers.username="${username}")`
            : `state="OPEN"`;
        const url = `${base}/repositories/${encodeURIComponent(repo.path.workspace)}/${encodeURIComponent(repo.path.repo)}/pullrequests?q=${encodeURIComponent(q)}&pagelen=50`;
        const res = await fetch(url, {
            headers: { Authorization: this.auth(token), Accept: "application/json" },
        });
        if (!res.ok) {
            throw new Error(`Bitbucket PRs ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as BbPaged<BbPullRequest>;
        return data.values.map(pr => ({
            id: `#${pr.id}`,
            title: pr.title,
            author: pr.author?.display_name ?? pr.author?.nickname ?? "?",
            repo: repo.displayName,
            updated: pr.updated_on,
            url: pr.links.html.href,
        }));
    }

    async listIssues(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = bbApiRoot(account.baseUrl);
        // Bitbucket per-repo issue tracker is opt-in; disabled trackers 404.
        // Filter via BBQL `q=` — the issue's state field uses values like
        // "new", "open", "on hold", etc. State and assignee filters AND'd
        // together. If we don't have the username cached we drop the
        // assignee predicate (returns all open issues in the repo).
        const username = await this.getCachedUsername(account, token);
        const stateClause = '(state="new" OR state="open" OR state="on hold")';
        const q = username
            ? `${stateClause} AND assignee.username="${username}"`
            : stateClause;
        const url = `${base}/repositories/${encodeURIComponent(repo.path.workspace)}/${encodeURIComponent(repo.path.repo)}/issues?q=${encodeURIComponent(q)}&pagelen=50`;
        const res = await fetch(url, {
            headers: { Authorization: this.auth(token), Accept: "application/json" },
        });
        if (res.status === 404) {
            return [];
        }
        if (!res.ok) {
            throw new Error(`Bitbucket issues ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as BbPaged<BbIssue>;
        return data.values.map(i => ({
            id: `#${i.id}`,
            title: i.title,
            author: i.assignee?.display_name
                ?? i.assignee?.nickname
                ?? i.reporter?.display_name
                ?? i.reporter?.nickname
                ?? "?",
            repo: repo.displayName,
            updated: i.updated_on,
            url: i.links.html.href,
        }));
    }

    repoWebUrls(account: Account, repo: RepoRef): RepoWebUrls {
        // Bitbucket Cloud's web UI lives at bitbucket.org regardless of which
        // host the user pointed the account at.
        const r = `https://bitbucket.org/${repo.path.workspace}/${repo.path.repo}`;
        const me = this.usernameByAccount.get(account.id);
        // Bitbucket Cloud has no first-class URL filter for "my PRs" — the UI
        // exposes Author/Reviewer filters via interactive controls only. Send
        // the user to the open-PRs list in both cases; the in-tree section
        // already shows their filtered view.
        return {
            myPrs: `${r}/pull-requests/`,
            allPrs: `${r}/pull-requests/`,
            newPr: `${r}/pull-requests/new`,
            myIssues: me
                ? `${r}/issues?responsible=${encodeURIComponent(me)}&status=new&status=open`
                : `${r}/issues?status=new&status=open`,
            allIssues: `${r}/issues?status=new&status=open`,
            newIssue: `${r}/issues/new`,
        };
    }
}
