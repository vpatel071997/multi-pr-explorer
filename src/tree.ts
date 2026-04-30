import * as vscode from "vscode";
import { Account, PullItem, TokenStatus } from "./providers/types";
import { listAccounts } from "./config";
import { TokenStore } from "./auth";
import { getClient } from "./providers";
import { describeFetchError } from "./providers/http";
import { scanWorkspace, WorkspaceRepo, UnmatchedRepo } from "./workspace";

type Section = "prs" | "issues";

type TreeNode =
    | AccountsGroupNode
    | AccountStatusNode
    | RepoNode
    | UnmatchedNode
    | InfoNode
    | SectionNode
    | ItemNode
    | ErrorNode;

class AccountsGroupNode {
    readonly type = "accounts-group";
    constructor(public statuses: AccountStatusNode[]) {}
}

class AccountStatusNode {
    readonly type = "account-status";
    constructor(public account: Account, public status: TokenStatus) {}
}

class RepoNode {
    readonly type = "repo";
    constructor(public repo: WorkspaceRepo, public sections: SectionNode[]) {}
}

class UnmatchedNode {
    readonly type = "unmatched";
    constructor(public entry: UnmatchedRepo) {}
}

class InfoNode {
    readonly type = "info";
    constructor(public message: string) {}
}

class SectionNode {
    readonly type = "section";
    constructor(
        public repo: WorkspaceRepo,
        public section: Section,
        public items: (ItemNode | ErrorNode)[],
        public total: number
    ) {}
}

class ItemNode {
    readonly type = "item";
    constructor(public section: Section, public item: PullItem) {}
}

class ErrorNode {
    readonly type = "error";
    constructor(public message: string) {}
}

const SECTION_LABEL: Record<Section, string> = {
    prs: "Pull Requests",
    issues: "Issues / Tickets",
};
const SECTION_ICON: Record<Section, string> = {
    prs: "git-pull-request",
    issues: "issues",
};

export class PrTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private rootCache: TreeNode[] | null = null;
    /** Auth status per account, populated in buildRoot. Reused by buildRepoNode. */
    private statusByAccount = new Map<string, TokenStatus>();

    constructor(private readonly tokens: TokenStore) {}

    refresh(): void {
        this.rootCache = null;
        this._onDidChange.fire();
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        switch (node.type) {
            case "accounts-group": {
                const ok = node.statuses.filter(s => s.status.ok).length;
                const t = new vscode.TreeItem(`Accounts (${ok} / ${node.statuses.length})`, vscode.TreeItemCollapsibleState.Expanded);
                t.iconPath = new vscode.ThemeIcon("organization");
                t.contextValue = "accounts-group";
                t.tooltip = "Token authentication status for each configured account.\nClick Refresh to re-test.";
                return t;
            }
            case "account-status": {
                const t = new vscode.TreeItem(node.account.label, vscode.TreeItemCollapsibleState.None);
                if (node.status.ok) {
                    t.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
                    t.description = `${node.account.kind} • ${node.status.user ?? "ok"}`;
                    t.tooltip = [
                        node.account.label,
                        `Provider: ${node.account.kind}`,
                        `Base URL: ${node.account.baseUrl}`,
                        `Authenticated as: ${node.status.user ?? "?"}`,
                    ].join("\n");
                } else {
                    t.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconFailed"));
                    t.description = `${node.account.kind} • ${node.status.error ?? "failed"}`;
                    t.tooltip = [
                        node.account.label,
                        `Provider: ${node.account.kind}`,
                        `Base URL: ${node.account.baseUrl}`,
                        `Error: ${node.status.error ?? "unknown"}`,
                        "",
                        "Run 'Multi-PR: Remove Account…' and re-add to update the token.",
                    ].join("\n");
                }
                t.contextValue = "account-status";
                return t;
            }
            case "repo": {
                const t = new vscode.TreeItem(node.repo.ref.displayName, vscode.TreeItemCollapsibleState.Expanded);
                t.iconPath = new vscode.ThemeIcon("repo");
                const issueAcc = node.repo.issueOverridden
                    ? ` • issues→${node.repo.issueAccount.label}`
                    : "";
                t.description = `${node.repo.account.label} • ${node.repo.account.kind}${issueAcc}`;
                t.tooltip = [
                    node.repo.folder.name,
                    node.repo.remoteUrl,
                    `PR account: ${node.repo.account.label}`,
                    node.repo.issueOverridden
                        ? `Issue account (override): ${node.repo.issueAccount.label}`
                        : `Issue account: ${node.repo.issueAccount.label}`,
                ].join("\n");
                t.contextValue = "repo";
                return t;
            }
            case "unmatched": {
                const t = new vscode.TreeItem(node.entry.folder.name, vscode.TreeItemCollapsibleState.None);
                t.iconPath = new vscode.ThemeIcon("warning");
                t.description = "no matching account";
                t.tooltip = `Remote: ${node.entry.remoteUrl}\n\nAdd a Multi-PR account whose host matches this remote, then refresh.`;
                t.contextValue = "unmatched";
                return t;
            }
            case "info": {
                const t = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
                t.iconPath = new vscode.ThemeIcon("info");
                return t;
            }
            case "section": {
                const t = new vscode.TreeItem(SECTION_LABEL[node.section], vscode.TreeItemCollapsibleState.Expanded);
                t.iconPath = new vscode.ThemeIcon(SECTION_ICON[node.section]);
                t.description = `${node.total}`;
                t.contextValue = `section.${node.section}`;
                return t;
            }
            case "item": {
                const it = node.item;
                const draftPrefix = it.draft ? "[Draft] " : "";
                const t = new vscode.TreeItem(`${it.id}  ${draftPrefix}${it.title}`, vscode.TreeItemCollapsibleState.None);
                t.description = `${it.author} • ${formatRelative(it.updated)}`;
                t.tooltip = [
                    it.title,
                    `${node.section === "prs" ? "Author" : "Assignee"}: ${it.author}`,
                    `Updated: ${it.updated}`,
                    it.draft ? "Status: Draft" : null,
                    it.url,
                ].filter(Boolean).join("\n");
                t.iconPath = new vscode.ThemeIcon(node.section === "prs" ? "git-pull-request" : "issues");
                t.command = {
                    command: "multiPrExplorer.openItem",
                    title: "Open in Browser",
                    arguments: [it],
                };
                t.contextValue = "item";
                return t;
            }
            case "error": {
                const t = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
                t.iconPath = new vscode.ThemeIcon("error");
                t.tooltip = node.message;
                return t;
            }
        }
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (!node) {
            if (this.rootCache) {
                return this.rootCache;
            }
            this.rootCache = await this.buildRoot();
            return this.rootCache;
        }
        if (node.type === "accounts-group") {
            return node.statuses;
        }
        if (node.type === "repo") {
            return node.sections;
        }
        if (node.type === "section") {
            return node.items;
        }
        return [];
    }

    private async buildRoot(): Promise<TreeNode[]> {
        const accounts = listAccounts();
        if (accounts.length === 0) {
            return [];
        }

        // Verify all account tokens in parallel — populates statusByAccount and
        // also drives the Accounts section icons.
        const statusNodes = await Promise.all(accounts.map(async acc => {
            const status = await this.verifyAccount(acc);
            this.statusByAccount.set(acc.id, status);
            return new AccountStatusNode(acc, status);
        }));
        const accountsGroup = new AccountsGroupNode(statusNodes);

        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            return [accountsGroup, new InfoNode("Open a folder or workspace with a git remote to see its PRs and issues.")];
        }

        const scan = await scanWorkspace(accounts);
        if (scan.repos.length === 0 && scan.unmatched.length === 0) {
            return [accountsGroup, new InfoNode("No git repos detected in this workspace.")];
        }

        const out: TreeNode[] = [accountsGroup];
        for (const repo of scan.repos) {
            out.push(await this.buildRepoNode(repo));
        }
        for (const unmatched of scan.unmatched) {
            out.push(new UnmatchedNode(unmatched));
        }
        return out;
    }

    private async verifyAccount(acc: Account): Promise<TokenStatus> {
        const token = await this.tokens.get(acc.id);
        if (!token) {
            return { ok: false, error: "no token in SecretStorage" };
        }
        try {
            return await getClient(acc.kind).verifyToken(acc, token);
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    private async buildRepoNode(repo: WorkspaceRepo): Promise<RepoNode> {
        const prToken = await this.tokens.get(repo.account.id);
        const issueToken = repo.issueAccount.id === repo.account.id
            ? prToken
            : await this.tokens.get(repo.issueAccount.id);

        const sections: SectionNode[] = [];

        const prStatus = this.statusByAccount.get(repo.account.id);
        if (!prToken) {
            sections.push(new SectionNode(repo, "prs", [new ErrorNode(`No token for "${repo.account.label}". Re-add the account.`)], 0));
        } else if (prStatus && !prStatus.ok) {
            sections.push(new SectionNode(repo, "prs", [new ErrorNode(`Token for "${repo.account.label}" failed verification: ${prStatus.error}`)], 0));
        } else {
            const prClient = getClient(repo.account.kind);
            const prs = await this.safeFetch(() => prClient.listPullRequests(repo.account, prToken, repo.ref));
            sections.push(this.toSection(repo, "prs", prs));
        }

        const issueStatus = this.statusByAccount.get(repo.issueAccount.id);
        if (!issueToken) {
            sections.push(new SectionNode(repo, "issues", [new ErrorNode(`No token for "${repo.issueAccount.label}". Re-add the account.`)], 0));
        } else if (issueStatus && !issueStatus.ok) {
            sections.push(new SectionNode(repo, "issues", [new ErrorNode(`Token for "${repo.issueAccount.label}" failed verification: ${issueStatus.error}`)], 0));
        } else {
            const issueClient = getClient(repo.issueAccount.kind);
            const issues = await this.safeFetch(() => issueClient.listIssues(repo.issueAccount, issueToken, repo.issueRef));
            sections.push(this.toSection(repo, "issues", issues));
        }

        return new RepoNode(repo, sections);
    }

    private async safeFetch(fn: () => Promise<PullItem[]>): Promise<PullItem[] | { error: string }> {
        try {
            return await fn();
        } catch (e) {
            return { error: describeFetchError(e) };
        }
    }

    private toSection(repo: WorkspaceRepo, section: Section, result: PullItem[] | { error: string }): SectionNode {
        if (!Array.isArray(result)) {
            return new SectionNode(repo, section, [new ErrorNode(result.error)], 0);
        }
        if (result.length === 0) {
            return new SectionNode(repo, section, [new ErrorNode(section === "prs" ? "No open PRs for you here." : "No assigned issues.")], 0);
        }
        const sorted = [...result].sort((a, b) => b.updated.localeCompare(a.updated));
        return new SectionNode(repo, section, sorted.map(it => new ItemNode(section, it)), sorted.length);
    }
}

function formatRelative(iso: string): string {
    const t = Date.parse(iso);
    if (isNaN(t)) {
        return iso;
    }
    const ms = Date.now() - t;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}
