import { Account, ProviderClient, PullItem } from "./types";

interface BbRepo {
    slug: string;
    full_name: string;
}

interface BbPullRequest {
    id: number;
    title: string;
    author?: { display_name?: string; nickname?: string };
    updated_on: string;
    links: { html: { href: string } };
}

interface BbPaged<T> {
    values: T[];
    next?: string;
}

const REPO_LIMIT = 50; // cap to avoid runaway when a workspace has hundreds of repos

export class BitbucketClient implements ProviderClient {
    async listOpen(account: Account, token: string): Promise<PullItem[]> {
        const workspace = account.extra?.workspace;
        if (!workspace) {
            throw new Error('Bitbucket account is missing extra.workspace. Re-add the account.');
        }
        // Bitbucket Cloud always API at api.bitbucket.org regardless of what user typed for base.
        const base = "https://api.bitbucket.org/2.0";
        const auth = "Basic " + Buffer.from(token).toString("base64");
        const headers: Record<string, string> = { Authorization: auth, Accept: "application/json" };

        // List repos in workspace where the user is a member.
        const reposUrl = `${base}/repositories/${encodeURIComponent(workspace)}?role=member&pagelen=100&fields=values.slug,values.full_name`;
        const repoRes = await fetch(reposUrl, { headers });
        if (!repoRes.ok) {
            throw new Error(`Bitbucket repos ${repoRes.status}: ${await repoRes.text()}`);
        }
        const repoData = (await repoRes.json()) as BbPaged<BbRepo>;
        const out: PullItem[] = [];

        for (const r of repoData.values.slice(0, REPO_LIMIT)) {
            const prUrl = `${base}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(r.slug)}/pullrequests?state=OPEN&pagelen=50`;
            const prRes = await fetch(prUrl, { headers });
            if (!prRes.ok) {
                // Skip repos we can't access — typical for archived / restricted repos.
                continue;
            }
            const prData = (await prRes.json()) as BbPaged<BbPullRequest>;
            for (const pr of prData.values) {
                out.push({
                    id: `#${pr.id}`,
                    title: pr.title,
                    author: pr.author?.display_name ?? pr.author?.nickname ?? "?",
                    repo: r.full_name,
                    updated: pr.updated_on,
                    url: pr.links.html.href,
                });
            }
        }
        return out;
    }
}
