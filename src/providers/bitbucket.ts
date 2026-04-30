import { Account, ProviderClient, PullItem, RepoRef } from "./types";

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
    parseRepoUrl(url: string, _account: Account): RepoRef | null {
        // Bitbucket Cloud is always bitbucket.org regardless of what the user
        // configured for baseUrl (api.bitbucket.org is the API host).
        const parsed = parseUrl(url);
        if (!parsed) return null;
        if (parsed.host !== "bitbucket.org") return null;
        return {
            url,
            displayName: `${parsed.workspace}/${parsed.repo}`,
            path: { workspace: parsed.workspace, repo: parsed.repo },
        };
    }

    private auth(token: string): string {
        return "Basic " + Buffer.from(token).toString("base64");
    }

    async listPullRequests(_account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = "https://api.bitbucket.org/2.0";
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

    async listIssues(_account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = "https://api.bitbucket.org/2.0";
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
