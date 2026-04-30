import * as vscode from "vscode";
import { Account, PullItem } from "./providers/types";
import { listAccounts } from "./config";
import { TokenStore } from "./auth";
import { getClient } from "./providers";

type Section = "prs" | "issues";

type TreeNode = AccountNode | SectionNode | RepoNode | ItemNode | ErrorNode;

class AccountNode {
    readonly type = "account";
    constructor(public account: Account, public sections: SectionNode[]) {}
}

class SectionNode {
    readonly type = "section";
    constructor(
        public account: Account,
        public section: Section,
        public repos: (RepoNode | ErrorNode)[],
        public total: number
    ) {}
}

class RepoNode {
    readonly type = "repo";
    constructor(public account: Account, public section: Section, public repo: string, public items: ItemNode[]) {}
}

class ItemNode {
    readonly type = "item";
    constructor(public account: Account, public section: Section, public item: PullItem) {}
}

class ErrorNode {
    readonly type = "error";
    constructor(public account: Account, public message: string) {}
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
    private cache = new Map<string, AccountNode>();

    constructor(private readonly tokens: TokenStore) {}

    refresh(): void {
        this.cache.clear();
        this._onDidChange.fire();
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        switch (node.type) {
            case "account": {
                const t = new vscode.TreeItem(node.account.label, vscode.TreeItemCollapsibleState.Expanded);
                t.description = `${node.account.kind} • ${shortHost(node.account.baseUrl)}`;
                t.iconPath = new vscode.ThemeIcon("organization");
                t.contextValue = "account";
                return t;
            }
            case "section": {
                const t = new vscode.TreeItem(SECTION_LABEL[node.section], vscode.TreeItemCollapsibleState.Expanded);
                t.iconPath = new vscode.ThemeIcon(SECTION_ICON[node.section]);
                t.description = `${node.total} open`;
                t.contextValue = `section.${node.section}`;
                return t;
            }
            case "repo": {
                const t = new vscode.TreeItem(node.repo, vscode.TreeItemCollapsibleState.Expanded);
                t.iconPath = new vscode.ThemeIcon("repo");
                t.description = `${node.items.length}`;
                return t;
            }
            case "item": {
                const it = node.item;
                const t = new vscode.TreeItem(`${it.id}  ${it.title}`, vscode.TreeItemCollapsibleState.None);
                t.description = `${it.author} • ${formatRelative(it.updated)}`;
                t.tooltip = `${it.title}\n${node.section === "prs" ? "Author" : "Assignee"}: ${it.author}\nUpdated: ${it.updated}\n${it.url}`;
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
            const accounts = listAccounts();
            if (accounts.length === 0) {
                return [];
            }
            const out: TreeNode[] = [];
            for (const acc of accounts) {
                const cached = this.cache.get(acc.id);
                if (cached) {
                    out.push(cached);
                    continue;
                }
                const fresh = await this.fetchAccount(acc);
                this.cache.set(acc.id, fresh);
                out.push(fresh);
            }
            return out;
        }
        if (node.type === "account") {
            return node.sections;
        }
        if (node.type === "section") {
            return node.repos;
        }
        if (node.type === "repo") {
            return node.items;
        }
        return [];
    }

    private async fetchAccount(acc: Account): Promise<AccountNode> {
        const token = await this.tokens.get(acc.id);
        if (!token) {
            // No token — render the account with one error node directly.
            const errSection = new SectionNode(acc, "prs", [new ErrorNode(acc, "No token in SecretStorage. Remove and re-add this account.")], 0);
            return new AccountNode(acc, [errSection]);
        }
        const client = getClient(acc.kind);
        const prs = await this.safeList(acc, () => client.listOpen(acc, token));
        const issues = await this.safeList(acc, () => client.listAssignedIssues(acc, token));
        return new AccountNode(acc, [
            this.toSection(acc, "prs", prs),
            this.toSection(acc, "issues", issues),
        ]);
    }

    private async safeList(acc: Account, fn: () => Promise<PullItem[]>): Promise<PullItem[] | { error: string }> {
        try {
            return await fn();
        } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
        }
    }

    private toSection(acc: Account, section: Section, items: PullItem[] | { error: string }): SectionNode {
        if ("error" in (items as object) && Array.isArray(items) === false) {
            const err = (items as { error: string }).error;
            return new SectionNode(acc, section, [new ErrorNode(acc, err)], 0);
        }
        const arr = items as PullItem[];
        const byRepo = new Map<string, ItemNode[]>();
        for (const it of arr) {
            const list = byRepo.get(it.repo) ?? [];
            list.push(new ItemNode(acc, section, it));
            byRepo.set(it.repo, list);
        }
        const repos: (RepoNode | ErrorNode)[] = [];
        for (const repo of [...byRepo.keys()].sort()) {
            const list = byRepo.get(repo)!;
            list.sort((a, b) => b.item.updated.localeCompare(a.item.updated));
            repos.push(new RepoNode(acc, section, repo, list));
        }
        if (repos.length === 0) {
            repos.push(new ErrorNode(acc, section === "prs" ? "No open PRs/MRs." : "No assigned issues."));
        }
        return new SectionNode(acc, section, repos, arr.length);
    }
}

function shortHost(url: string): string {
    return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
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
