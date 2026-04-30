import { Account, ProviderClient, PullItem, RepoRef, TokenStatus } from "./types";

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
        try {
            const url = `${bbApiRoot(account.baseUrl)}/user`;
            const res = await fetch(url, {
                headers: { Authorization: this.auth(token), Accept: "application/json" },
            });
            if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}` };
            }
            const data = (await res.json()) as { username?: string; display_name?: string; nickname?: string };
            return { ok: true, user: data.username ?? data.nickname ?? data.display_name ?? "?" };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    async listPullRequests(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = bbApiRoot(account.baseUrl);
        const url = `${base}/repositories/${encodeURIComponent(repo.path.workspace)}/${encodeURIComponent(repo.path.repo)}/pullrequests?state=OPEN&pagelen=50`;
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
        // Bitbucket Cloud per-repo issues; many repos have issue tracking disabled,
        // returning 404 in that case. Treat 404 as "no issues for this repo".
        const url = `${base}/repositories/${encodeURIComponent(repo.path.workspace)}/${encodeURIComponent(repo.path.repo)}/issues?status=new&status=open&pagelen=50`;
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
}
