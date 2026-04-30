import * as vscode from "vscode";
import { TokenStore } from "./auth";
import { addAccount, listAccounts, removeAccount } from "./config";
import { PrTreeProvider } from "./tree";
import { Account, ProviderKind, PullItem } from "./providers/types";

interface ProviderChoice {
    label: string;
    kind: ProviderKind;
    defaultBaseUrl: string;
    needsExtra: "workspace" | "organization" | null;
    tokenPrompt: string;
}

const PROVIDERS: ProviderChoice[] = [
    {
        label: "GitHub (cloud or Enterprise)",
        kind: "github",
        defaultBaseUrl: "https://github.com",
        needsExtra: null,
        tokenPrompt: "GitHub Personal Access Token (classic or fine-grained, with `repo` read scope)",
    },
    {
        label: "GitLab (cloud or self-hosted)",
        kind: "gitlab",
        defaultBaseUrl: "https://gitlab.com",
        needsExtra: null,
        tokenPrompt: "GitLab Personal Access Token (`read_api` scope)",
    },
    {
        label: "Bitbucket Cloud",
        kind: "bitbucket",
        defaultBaseUrl: "https://api.bitbucket.org",
        needsExtra: "workspace",
        tokenPrompt: "Bitbucket credentials as 'username:apppassword' (or 'email:apitoken')",
    },
    {
        label: "Azure DevOps (cloud)",
        kind: "azure",
        defaultBaseUrl: "https://dev.azure.com",
        needsExtra: "organization",
        tokenPrompt: "Azure DevOps Personal Access Token (Code: Read scope)",
    },
];

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    const tokens = new TokenStore(ctx.secrets);
    const tree = new PrTreeProvider(tokens);

    const view = vscode.window.createTreeView("multiPrExplorer.tree", {
        treeDataProvider: tree,
        showCollapseAll: true,
    });
    ctx.subscriptions.push(view);

    ctx.subscriptions.push(
        vscode.commands.registerCommand("multiPrExplorer.refresh", () => tree.refresh()),
        vscode.commands.registerCommand("multiPrExplorer.openItem", (item: PullItem) => {
            if (item?.url) {
                vscode.env.openExternal(vscode.Uri.parse(item.url));
            }
        }),
        vscode.commands.registerCommand("multiPrExplorer.addAccount", () =>
            addAccountFlow(tokens, tree)
        ),
        vscode.commands.registerCommand("multiPrExplorer.removeAccount", () =>
            removeAccountFlow(tokens, tree)
        ),
    );

    ctx.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("multiPrExplorer.accounts")) {
                tree.refresh();
            }
        })
    );
}

export function deactivate(): void {
    /* no-op */
}

async function addAccountFlow(tokens: TokenStore, tree: PrTreeProvider): Promise<void> {
    const provider = await vscode.window.showQuickPick(
        PROVIDERS.map(p => ({ label: p.label, provider: p })),
        { placeHolder: "Provider" }
    );
    if (!provider) {
        return;
    }
    const p = provider.provider;

    const label = await vscode.window.showInputBox({
        prompt: "Account label (display only)",
        placeHolder: "e.g. Work, Personal, Acme",
    });
    if (!label) {
        return;
    }

    const baseUrl = await vscode.window.showInputBox({
        prompt: "Base URL",
        value: p.defaultBaseUrl,
    });
    if (!baseUrl) {
        return;
    }

    const extra: Record<string, string> = {};
    if (p.needsExtra === "workspace") {
        const ws = await vscode.window.showInputBox({
            prompt: "Bitbucket workspace slug",
            placeHolder: "e.g. acme-team",
        });
        if (!ws) {
            return;
        }
        extra.workspace = ws;
    } else if (p.needsExtra === "organization") {
        const org = await vscode.window.showInputBox({
            prompt: "Azure DevOps organization slug",
            placeHolder: "e.g. acme",
        });
        if (!org) {
            return;
        }
        extra.organization = org;
    }

    const token = await vscode.window.showInputBox({
        prompt: p.tokenPrompt,
        password: true,
    });
    if (!token) {
        return;
    }

    const id = `${p.kind}-${slugify(label)}-${Date.now().toString(36)}`;
    const account: Account = {
        id,
        label,
        kind: p.kind,
        baseUrl,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };

    try {
        await addAccount(account);
        await tokens.set(id, token);
        tree.refresh();
        vscode.window.showInformationMessage(`Added ${p.label}: ${label}`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to add account: ${msg}`);
    }
}

async function removeAccountFlow(tokens: TokenStore, tree: PrTreeProvider): Promise<void> {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        vscode.window.showInformationMessage("No accounts configured.");
        return;
    }
    const pick = await vscode.window.showQuickPick(
        accounts.map(a => ({
            label: a.label,
            description: `${a.kind} • ${a.baseUrl}`,
            account: a,
        })),
        { placeHolder: "Account to remove" }
    );
    if (!pick) {
        return;
    }
    const confirm = await vscode.window.showWarningMessage(
        `Remove "${pick.account.label}"? Token will be deleted from SecretStorage.`,
        { modal: true },
        "Remove"
    );
    if (confirm !== "Remove") {
        return;
    }
    await removeAccount(pick.account.id);
    await tokens.delete(pick.account.id);
    tree.refresh();
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}
