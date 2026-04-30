export type ProviderKind = "github" | "gitlab" | "bitbucket" | "azure";

export interface Account {
    id: string;
    label: string;
    kind: ProviderKind;
    baseUrl: string;
    /** Provider-specific extras (Bitbucket: workspace; Azure: organization). */
    extra?: Record<string, string>;
}

/** A repository identified by its remote URL, parsed by a specific provider. */
export interface RepoRef {
    /** The original git remote URL — used to dedupe and to display. */
    url: string;
    /** Friendly name for the tree: "owner/repo" or "org/project/repo". */
    displayName: string;
    /** Provider-specific path bag (owner/repo, group/.../project, org/project/repo, etc.). */
    path: Record<string, string>;
}

/** Shared shape used for both pull/merge requests and issues/work items. */
export interface PullItem {
    id: string;
    title: string;
    /** Author for PRs/MRs; primary assignee for issues/work items. */
    author: string;
    /** Repo display name; matches RepoRef.displayName. */
    repo: string;
    /** ISO timestamp of last update. */
    updated: string;
    /** Browser URL to open on click. */
    url: string;
    /** True for draft PRs/MRs. Issues/work items leave this undefined. */
    draft?: boolean;
}

/** Result of a lightweight authenticated probe to the provider. */
export interface TokenStatus {
    ok: boolean;
    /** Authenticated user/login on success. */
    user?: string;
    /** Brief error string on failure (HTTP status code, reason, etc.). */
    error?: string;
}

export interface ProviderClient {
    /**
     * Try to parse this remote URL as belonging to this account's provider.
     * Returns null if the URL clearly doesn't fit (different host, malformed,
     * missing required components like an Azure DevOps project segment).
     */
    parseRepoUrl(url: string, account: Account): RepoRef | null;
    /** Hit a small authenticated endpoint to confirm the token works. */
    verifyToken(account: Account, token: string): Promise<TokenStatus>;
    /** Fetch open PRs/MRs for the given repo. */
    listPullRequests(account: Account, token: string, repo: RepoRef): Promise<PullItem[]>;
    /** Fetch open issues/work items assigned to the authenticated user, scoped to this repo/project. */
    listIssues(account: Account, token: string, repo: RepoRef): Promise<PullItem[]>;
}
