import { Account, ProviderClient, PullItem, RepoRef, RepoWebUrls, TokenStatus } from "./types";
import { probe, describeProbe } from "./http";

interface AdoIdentity {
    id?: string;
    displayName?: string;
    uniqueName?: string;
}

interface AdoPullRequest {
    pullRequestId: number;
    title: string;
    createdBy?: AdoIdentity;
    reviewers?: AdoIdentity[];
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
    /** authenticated user GUID per accountId; populated by verifyToken. */
    private userIdByAccount = new Map<string, string>();

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
        const org = account.extra?.organization;
        if (!org) {
            return { ok: false, error: "missing organization in account" };
        }
        const base = account.baseUrl.replace(/\/+$/, "");
        const headers = { Authorization: this.auth(token), Accept: "application/json" };

        // Try three probes in order. Any one succeeding means the credentials
        // and base URL are usable. We surface all three failures together so
        // the user can see exactly which URL+status returned for each.
        const collectionCd = `${base}/${encodeURIComponent(org)}/_apis/connectionData?api-version=1.0`;
        const collectionPj = `${base}/${encodeURIComponent(org)}/_apis/projects?api-version=1.0&$top=1`;
        const serverCd     = `${base}/_apis/connectionData?api-version=1.0`;

        const cd = await probe(collectionCd, headers);
        if (cd.ok) {
            try {
                const d = JSON.parse(cd.bodyText ?? "{}") as {
                    authenticatedUser?: { id?: string; providerDisplayName?: string; customDisplayName?: string };
                };
                const u = d.authenticatedUser;
                if (u?.id) {
                    this.userIdByAccount.set(account.id, u.id);
                }
                return { ok: true, user: u?.providerDisplayName ?? u?.customDisplayName ?? org };
            } catch {
                return { ok: true, user: org };
            }
        }

        const pj = await probe(collectionPj, headers);
        if (pj.ok) {
            return { ok: true, user: org };
        }

        const sv = await probe(serverCd, headers);
        if (sv.ok) {
            // Reaching the server but not the collection usually means the
            // collection name is wrong (case-sensitive) or the user lacks access.
            return { ok: false, error: `Authenticated to server but collection "${org}" probe failed. Verify the collection name (case-sensitive) and that your PAT has access. Detail: ${describeProbe(cd, collectionCd)}` };
        }

        return { ok: false, error: [
            describeProbe(cd, collectionCd),
            describeProbe(pj, collectionPj),
            describeProbe(sv, serverCd),
        ].join(" | ") };
    }

    async listPullRequests(account: Account, _token: string, repo: RepoRef): Promise<PullItem[]> {
        const base = account.baseUrl.replace(/\/+$/, "");
        const { org, project, repo: repoName } = repo.path;
        // pullrequests: api-version=3.0 is the minimum supported (Git was
        // added to TFS in 2017/API 3.0). Cloud accepts it too. 7.1 returned
        // 404 on older on-prem TFS that didn't have the 7.x preview surface.
        const url = `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests?searchCriteria.status=active&api-version=3.0&$top=100`;
        const res = await fetch(url, {
            headers: { Authorization: this.auth(_token), Accept: "application/json" },
        });
        if (!res.ok) {
            throw new Error(`Azure DevOps PRs ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json()) as AdoResponse;
        const myId = this.userIdByAccount.get(account.id);
        const filtered = myId
            ? data.value.filter(pr =>
                pr.createdBy?.id === myId ||
                pr.reviewers?.some(r => r.id === myId))
            : data.value;
        return filtered.map(pr => ({
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
        // WIQL has been a 1.0 endpoint since TFS 2015 U1; using a preview
        // version (7.1-preview.2) caused 404 on TFS that didn't ship the
        // newer preview surface. 1.0 works on cloud + every supported TFS.
        const wiqlUrl = `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=1.0`;
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
        // api-version=1.0 supported since TFS 2015 U1.
        const wiUrl = `${base}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${ids}&fields=${encodeURIComponent(fields)}&api-version=1.0`;
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

    repoWebUrls(account: Account, repo: RepoRef): RepoWebUrls {
        const base = account.baseUrl.replace(/\/+$/, "");
        const { org, project, repo: repoName } = repo.path;
        const o = encodeURIComponent(org);
        const p = encodeURIComponent(project);
        const r = encodeURIComponent(repoName);
        // ADO's web filters auto-detect the logged-in user, so "mine" URLs
        // don't need a username token. _a=mine and assignedtome views are
        // available on cloud and on-prem TFS 2018+.
        return {
            myPrs: `${base}/${o}/${p}/_git/${r}/pullrequests?_a=mine`,
            allPrs: `${base}/${o}/${p}/_git/${r}/pullrequests?_a=active`,
            newPr: `${base}/${o}/${p}/_git/${r}/pullrequestcreate`,
            myIssues: `${base}/${o}/${p}/_workitems/assignedtome/`,
            allIssues: `${base}/${o}/${p}/_workitems/`,
            // ADO requires a work item type for direct create URLs; a generic
            // "+ New Work Item" entry doesn't exist as a deep link. Send the
            // user to the work items page where the New button is one click.
            newIssue: `${base}/${o}/${p}/_workitems/`,
        };
    }
}
