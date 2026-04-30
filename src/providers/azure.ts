import { Account, ProviderClient, PullItem, RepoRef } from "./types";

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

function parseUrl(url: string): { host: string; org: string; project: string; repo: string } | null {
    let s = url.replace(/\.git$/, "").replace(/\/+$/, "");
    let m = s.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/i);
    if (m) return { host: "dev.azure.com", org: m[1], project: m[2], repo: m[3] };
    m = s.match(/^[^@]+@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (m) return { host: "dev.azure.com", org: m[1], project: m[2], repo: m[3] };
    m = s.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)/i);
    if (m) return { host: "dev.azure.com", org: m[1], project: m[2], repo: m[3] };
    return null;
}

export class AzureClient implements ProviderClient {
    parseRepoUrl(url: string, account: Account): RepoRef | null {
        const parsed = parseUrl(url);
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
        const wiUrl = `${base}/${encodeURIComponent(org)}/_apis/wit/workitems?ids=${ids}&fields=${encodeURIComponent(fields)}&api-version=7.1`;
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
