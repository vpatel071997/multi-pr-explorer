import { Account, ProviderClient, PullItem } from "./types";

interface SearchIssue {
    number: number;
    title: string;
    user: { login: string };
    updated_at: string;
    html_url: string;
    repository_url: string; // "https://api.github.com/repos/owner/repo"
}

interface SearchResponse {
    items: SearchIssue[];
}

function apiBase(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const host = trimmed.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (host === "github.com") {
        return "https://api.github.com";
    }
    // GitHub Enterprise: <base>/api/v3
    return `${trimmed}/api/v3`;
}

function repoFromUrl(repoUrl: string): string {
    // ".../repos/owner/repo" -> "owner/repo"
    const m = repoUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    return m ? m[1] : repoUrl;
}

export class GitHubClient implements ProviderClient {
    async listOpen(account: Account, token: string): Promise<PullItem[]> {
        const api = apiBase(account.baseUrl);
        // PRs the authenticated user authored or is requested to review.
        // Two queries because GitHub search has no native "OR involve" with both filters reliably.
        const queries = [
            "is:pr+is:open+author:@me",
            "is:pr+is:open+review-requested:@me",
        ];
        const seen = new Set<string>();
        const out: PullItem[] = [];
        for (const q of queries) {
            const url = `${api}/search/issues?q=${q}&per_page=50`;
            const res = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "User-Agent": "multi-pr-explorer",
                },
            });
            if (!res.ok) {
                throw new Error(`GitHub ${res.status}: ${await res.text()}`);
            }
            const data = (await res.json()) as SearchResponse;
            for (const item of data.items) {
                if (seen.has(item.html_url)) {
                    continue;
                }
                seen.add(item.html_url);
                out.push({
                    id: `#${item.number}`,
                    title: item.title,
                    author: item.user.login,
                    repo: repoFromUrl(item.repository_url),
                    updated: item.updated_at,
                    url: item.html_url,
                });
            }
        }
        return out;
    }
}
