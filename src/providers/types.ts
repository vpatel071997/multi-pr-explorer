export type ProviderKind = "github" | "gitlab" | "bitbucket" | "azure";

export interface Account {
    id: string;
    label: string;
    kind: ProviderKind;
    baseUrl: string;
    /** Provider-specific extras (Bitbucket: workspace; Azure: organization). */
    extra?: Record<string, string>;
}

/** Shared shape used for both pull/merge requests and issues/work items. */
export interface PullItem {
    /** "#1234" or "PR-456" — what's shown in the tree. */
    id: string;
    title: string;
    /** Author for PRs/MRs; primary assignee for issues/work items. */
    author: string;
    /** Human-readable repo identifier — "owner/repo" for GH, full path for GL/BB, "project/repo" for ADO. */
    repo: string;
    /** ISO timestamp of last update. */
    updated: string;
    /** Browser URL to open on click. */
    url: string;
}

export interface ProviderClient {
    /** Fetch open PRs/MRs the user is involved with. */
    listOpen(account: Account, token: string): Promise<PullItem[]>;
    /** Fetch open issues / tickets / work items assigned to the authenticated user. */
    listAssignedIssues(account: Account, token: string): Promise<PullItem[]>;
}
