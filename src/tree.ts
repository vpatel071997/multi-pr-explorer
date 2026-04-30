import * as vscode from "vscode";
import { Account, PullItem } from "./providers/types";
import { listAccounts } from "./config";
import { TokenStore } from "./auth";
import { getClient } from "./providers";

type TreeNode = AccountNode | RepoNode | ItemNode | ErrorNode;

class AccountNode {
    readonly type = "account";
    constructor(public account: Account, public children: (RepoNode | ErrorNode)[]) {}
}

class RepoNode {
    readonly type = "repo";
    constructor(public account: Account, public repo: string, public items: ItemNode[]) {}
}

class ItemNode {
    readonly type = "item";
    constructor(public account: Account, public item: PullItem) {}
}

class ErrorNode {
    readonly type = "error";
    constructor(public account: Account, public message: string) {}
}

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
            case "repo": {
                const t = new vscode.TreeItem(node.repo, vscode.TreeItemCollapsibleState.Expanded);
                t.iconPath = new vscode.ThemeIcon("repo");
                t.description = `${node.items.length} open`;
                return t;
            }
            case "item": {
                const it = node.item;
                const t = new vscode.TreeItem(`${it.id}  ${it.title}`, vscode.TreeItemCollapsibleState.None);
                t.description = `${it.author} • ${formatRelative(it.updated)}`;
                t.tooltip = `${it.title}\nAuthor: ${it.author}\nUpdated: ${it.updated}\n${it.url}`;
                t.iconPath = new vscode.ThemeIcon("git-pull-request");
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
            return node.children;
        }
        if (node.type === "repo") {
            return node.items;
        }
        return [];
    }

    private async fetchAccount(acc: Account): Promise<AccountNode> {
        const token = await this.tokens.get(acc.id);
        if (!token) {
            return new AccountNode(acc, [new ErrorNode(acc, "No token in SecretStorage. Remove and re-add this account.")]);
        }
        try {
            const client = getClient(acc.kind);
            const items = await client.listOpen(acc, token);
            const byRepo = new Map<string, ItemNode[]>();
            for (const it of items) {
                const arr = byRepo.get(it.repo) ?? [];
                arr.push(new ItemNode(acc, it));
                byRepo.set(it.repo, arr);
            }
            const repos: RepoNode[] = [];
            for (const repo of [...byRepo.keys()].sort()) {
                const arr = byRepo.get(repo)!;
                arr.sort((a, b) => b.item.updated.localeCompare(a.item.updated));
                repos.push(new RepoNode(acc, repo, arr));
            }
            if (repos.length === 0) {
                return new AccountNode(acc, [new ErrorNode(acc, "No open PRs/MRs.")]);
            }
            return new AccountNode(acc, repos);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return new AccountNode(acc, [new ErrorNode(acc, msg)]);
        }
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
