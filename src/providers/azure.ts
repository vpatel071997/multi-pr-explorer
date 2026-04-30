import { Account, ProviderClient, PullItem, RepoRef, TokenStatus } from "./types";

interface AdoPullRequest {
    pullRequestId: number;
    title: string;
    createdBy?: { displayName?: string; uniqueName?: string };
    creationDate: string;
    isDraft?: boolean;
    repository: {
        name: string;
        project: { name: string };
    };
}

interface AdoResponse {
    value: AdoPullRequest[];
}

interface WiqlResponse {
    workItems: { id: number }[];
}

interface WorkItem {
    id: number;
    fields: {
        "System.Title": string;
        "System.State": string;
        "System.WorkItemType": string;
        "System.TeamProject": string;
        "System.AssignedTo"?: { displayName?: string; uniqueName?: string };
        "System.ChangedDate": string;
    };
}

interface WorkItemBatch {
    value: WorkItem[];
}

function parseUrl(url: string, account?: Account): { host: string; org: string; project: string; repo: string } | null {
    const s = url.replace(/\.git$/, "").replace(/\/+$/, "");

    // Cloud patterns (in order: HTTPS dev.azure.com, SSH dev.azure.com, legacy *.visualstudio.com).
    let m = s.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/i);
    if (m) return { host: "dev.azure.com", org: m[1], project: m[2], repo: m[3] };
    m = s.match(/^[^@]+@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (m) return { host: "dev.azure.com", org: m[1], project: m[2], repo: m[3] };
    m = s.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/i);
    if (m) return { host: "dev.azure.com", org: m[1], project: m[2], repo: m[3] };

    // Azure DevOps Server / TFS: any URL whose prefix matches the configured
    // account.baseUrl, followed by `{collection}/{project}/_git/{repo}`.
    // Example: baseUrl = https://gide-afs.web.apple.com/tfs, repo URL =
    //   https://gide-afs.web.apple.com/tfs/BRT/APPL_ONE/_git/some-repo
    // → collection = BRT, project = APPL_ONE, repo = some-repo.
    if (account) {
        const accBase = account.baseUrl.replace(/\/+$/, "");
        const sLower = s.toLowerCase();
        const accLower = accBase.toLowerCase();
        if (sLower.startsWith(accLower + "/")) {
            const remainder = s.substring(accBase.length).replace(/^\/+/, "");
            const tfs = remainder.match(/^([^/]+)\/([^/]+)\/_git\/([^/]+)/);
            if (tfs) {
                const host = accBase.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
                return { host, org: tfs[1], project: tfs[2], repo: tfs[3] };
            }
        }
    }

    return null;
}

export class AzureClient implements ProviderClient {
    parseRepoUrl(url: string, account: Account): RepoRef | null {
        const parsed = parseUrl(url, account);
        if (!parsed) return null;
        // Match by configured organization to disambiguate when a user has
        // multiple ADO accounts (different orgs).
        const accOrg = account.extra?.organization?.toLowerCase();
        if (accOrg && accOrg !== parsed.org.toLowerCase()) return null;
        return {
            url,
            displayName: `${parsed.org}/${parsed.project}/${parsed.repo}`,
            path: { org: parsed.org, project: parsed.project, repo: parsed.repo },
        };
    }

    private auth(token: string): string {
        return "Basic " + Buffer.from(":" + token).toString("base64");
    }

    async verifyToken(account: Account, token: string): Promise<TokenStatus> {
        try {
            const org = account.extra?.organization;
            if (!org) {
                return { ok: false, error: "missing organization in account" };
            }
            const url = `${account.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(org)}/_apis/connectionData?api-version=7.1`;
            const res = await fetch(url, { headers: { Authorization: this.auth(token), Accept: "application/json" } });
            if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}` };
            }
            const data = (await res.json()) as {
                authenticatedUser?: { providerDisplayName?: string; customDisplayName?: string };
            };
            const u = data.authenticatedUser;
            return { ok: true, user: u?.providerDisplayName ?? u?.customDisplayName ?? "?" };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    async listPullRequests(account: Account, _token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = account.baseUrl.replace(/\/+$/, "");
        const { org, project, repo: repoName } = repo.path;
        const url = `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests?searchCriteria.status=active&api-version=7.1-preview.1&$top=100`;
        const res = await fetch(url, {
            headers: { Authorization: this.auth(_token), Accept: "application/json" },
        });
        if (!res.ok) {
            throw new Error(`Azure DevOps PRs ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as AdoResponse;
        return data.value.map(pr => ({
            id: `#${pr.pullRequestId}`,
            title: pr.title,
            author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "?",
            repo: repo.displayName,
            updated: pr.creationDate,
            url: `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`,
            draft: pr.isDraft === true,
        }));
    }

    async listIssues(account: Account, token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = account.baseUrl.replace(/\/+$/, "");
        const { org, project } = repo.path;
        const headers: Record<string, string> = {
            Authorization: this.auth(token),
            Accept: "application/json",
            "Content-Type": "application/json",
        };

        // WIQL: assigned-to-me work items in this project.
        const wiql = {
            query:
                `SELECT [System.Id] FROM WorkItems ` +
                `WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' ` +
                `AND [System.AssignedTo] = @Me ` +
                `AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') ` +
                `ORDER BY [System.ChangedDate] DESC`,
        };
        const wiqlUrl = `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1-preview.2`;
        const wiqlRes = await fetch(wiqlUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(wiql),
        });
        if (!wiqlRes.ok) {
            throw new Error(`Azure DevOps WIQL ${wiqlRes.status}: ${await wiqlRes.text()}`);
        }
        const wiqlData = (await wiqlRes.json()) as WiqlResponse;
        if (!wiqlData.workItems || wiqlData.workItems.length === 0) {
            return [];
        }

        const ids = wiqlData.workItems.slice(0, 100).map(w => w.id).join(",");
        const fields = [
            "System.Title",
            "System.State",
            "System.WorkItemType",
            "System.TeamProject",
            "System.AssignedTo",
            "System.ChangedDate",
        ].join(",");
        // Project-scoped URL: matches Microsoft's "List Work Items" docs and
        // is consistent with the project-scoped WIQL POST above. Some tenants
        // with stricter access rules require the project segment.
        const wiUrl = `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${ids}&fields=${encodeURIComponent(fields)}&api-version=7.1`;
        const wiRes = await fetch(wiUrl, { headers });
        if (!wiRes.ok) {
            throw new Error(`Azure DevOps workitems ${wiRes.status}: ${await wiRes.text()}`);
        }
        const wiData = (await wiRes.json()) as WorkItemBatch;
        return wiData.value.map(w => {
            const proj = w.fields["System.TeamProject"];
            const type = w.fields["System.WorkItemType"];
            return {
                id: `${type} #${w.id}`,
                title: w.fields["System.Title"],
                author: w.fields["System.AssignedTo"]?.displayName
                    ?? w.fields["System.AssignedTo"]?.uniqueName
                    ?? "?",
                repo: repo.displayName,
                updated: w.fields["System.ChangedDate"],
                url: `${base}/${encodeURIComponent(org)}/${encodeURIComponent(proj)}/_workitems/edit/${w.id}`,
            };
        });
    }
}
