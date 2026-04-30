import { Account, ProviderClient, PullItem } from "./types";

interface MergeRequest {
    iid: number;
    title: string;
    author: { username: string };
    updated_at: string;
    web_url: string;
    references: { full: string }; // "group/project!123"
}

export class GitLabClient implements ProviderClient {
    async listOpen(account: Account, token: string): Promise<PullItem[]> {
        const base = account.baseUrl.replace(/\/+$/, "");
        // Authored MRs first, then assigned-to-me / reviewer queries via separate scopes.
        // scope=created_by_me / assigned_to_me are cheaper and well-supported on self-hosted.
        const scopes = ["created_by_me", "assigned_to_me"];
        const seen = new Set<string>();
        const out: PullItem[] = [];
        for (const scope of scopes) {
            const url = `${base}/api/v4/merge_requests?scope=${scope}&state=opened&per_page=50`;
            const res = await fetch(url, {
                headers: {
                    "PRIVATE-TOKEN": token,
                },
            });
            if (!res.ok) {
                throw new Error(`GitLab ${res.status}: ${await res.text()}`);
            }
            const data = (await res.json()) as MergeRequest[];
            for (const mr of data) {
                if (seen.has(mr.web_url)) {
                    continue;
                }
                seen.add(mr.web_url);
                // references.full is "group/project!iid" — strip the "!iid" suffix.
                const repo = mr.references.full.replace(/![0-9]+$/, "");
                out.push({
                    id: `!${mr.iid}`,
                    title: mr.title,
                    author: mr.author.username,
                    repo,
                    updated: mr.updated_at,
                    url: mr.web_url,
                });
            }
        }
        return out;
    }
}
