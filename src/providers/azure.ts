import { Account, ProviderClient, PullItem } from "./types";

interface AdoPullRequest {
    pullRequestId: number;
    title: string;
    createdBy?: { displayName?: string; uniqueName?: string };
    creationDate: string;
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

export class AzureClient implements ProviderClient {
    async listOpen(account: Account, token: string): Promise<PullItem[]> {
        const org = account.extra?.organization;
        if (!org) {
            throw new Error('Azure DevOps account is missing extra.organization. Re-add the account.');
        }
        const base = account.baseUrl.replace(/\/+$/, ""); // typically https://dev.azure.com
        const url = `${base}/${encodeURIComponent(org)}/_apis/git/pullrequests?searchCriteria.status=active&api-version=7.1-preview.1&$top=100`;
        const auth = "Basic " + Buffer.from(":" + token).toString("base64");

        const res = await fetch(url, {
            headers: { Authorization: auth, Accept: "application/json" },
        });
        if (!res.ok) {
            throw new Error(`Azure DevOps ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as AdoResponse;
        return data.value.map(pr => ({
            id: `#${pr.pullRequestId}`,
            title: pr.title,
            author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "?",
            repo: `${pr.repository.project.name}/${pr.repository.name}`,
            updated: pr.creationDate, // ADO active PR objects don't expose updated_at consistently
            url: `${base}/${encodeURIComponent(org)}/${encodeURIComponent(pr.repository.project.name)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
        }));
    }

    async listAssignedIssues(account: Account, token: string): Promise<PullItem[]> {
        const org = account.extra?.organization;
        if (!org) {
            throw new Error('Azure DevOps account is missing extra.organization. Re-add the account.');
        }
        const base = account.baseUrl.replace(/\/+$/, "");
        const auth = "Basic " + Buffer.from(":" + token).toString("base64");
        const headers: Record<string, string> = {
            Authorization: auth,
            Accept: "application/json",
            "Content-Type": "application/json",
        };

        // Step 1: WIQL query → list of {id} pairs.
        const wiql = {
            query:
                "SELECT [System.Id] FROM WorkItems " +
                "WHERE [System.AssignedTo] = @Me " +
                "AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved') " +
                "ORDER BY [System.ChangedDate] DESC",
        };
        const wiqlUrl = `${base}/${encodeURIComponent(org)}/_apis/wit/wiql?api-version=7.1-preview.2`;
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

        // Step 2: Batch-fetch the work items' fields. The /workitems endpoint
        // accepts up to 200 ids per call; cap at 100 to keep response size sane.
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
            const project = w.fields["System.TeamProject"];
            const type = w.fields["System.WorkItemType"];
            return {
                id: `${type} #${w.id}`,
                title: w.fields["System.Title"],
                author: w.fields["System.AssignedTo"]?.displayName
                    ?? w.fields["System.AssignedTo"]?.uniqueName
                    ?? "?",
                repo: project,
                updated: w.fields["System.ChangedDate"],
                url: `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${w.id}`,
            };
        });
    }
}
