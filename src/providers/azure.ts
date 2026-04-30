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
}
