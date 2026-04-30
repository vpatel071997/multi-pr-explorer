import * as vscode from "vscode";
import { TokenStore } from "./auth";
import { addAccount, listAccounts, removeAccount, getRefreshIntervalMinutes } from "./config";
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
        tokenPrompt: "Azure DevOps Personal Access Token (Code: Read + Work Items: Read)",
    },
];

let refreshTimer: NodeJS.Timeout | null = null;

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
        vscode.commands.registerCommand("multiPrExplorer.openRepo", (node: { repo?: { remoteUrl?: string } } | undefined) => {
            const url = node?.repo?.remoteUrl;
            if (!url) { return; }
            const web = remoteToWebUrl(url);
            if (web) {
                vscode.env.openExternal(vscode.Uri.parse(web));
            } else {
                vscode.window.showWarningMessage(`Don't know how to open this remote in a browser: ${url}`);
            }
        }),
        vscode.commands.registerCommand("multiPrExplorer.copyUrl", async (item: PullItem) => {
            if (item?.url) {
                await vscode.env.clipboard.writeText(item.url);
                vscode.window.setStatusBarMessage(`Copied: ${item.url}`, 2000);
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
            if (e.affectsConfiguration("multiPrExplorer.accounts") ||
                e.affectsConfiguration("multiPrExplorer.issueTrackerMap")) {
                tree.refresh();
            }
            if (e.affectsConfiguration("multiPrExplorer.refreshIntervalMinutes")) {
                restartAutoRefresh(tree);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
        { dispose: () => stopAutoRefresh() }
    );

    restartAutoRefresh(tree);
}

export function deactivate(): void {
    stopAutoRefresh();
}

function restartAutoRefresh(tree: PrTreeProvider): void {
    stopAutoRefresh();
    const minutes = getRefreshIntervalMinutes();
    if (minutes <= 0) { return; }
    refreshTimer = setInterval(() => tree.refresh(), minutes * 60 * 1000);
}

function stopAutoRefresh(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

/** Convert a git remote URL into a browser URL. Returns null if we can't tell. */
function remoteToWebUrl(remote: string): string | null {
    const trimmed = remote.replace(/\.git$/, "").replace(/\/+$/, "");
    // Already an HTTPS URL — just return after stripping .git.
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    // ssh://git@host/path or git@host:path
    let m = trimmed.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/);
    if (m) { return `https://${m[1]}/${m[2]}`; }
    m = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
    if (m) {
        const host = m[1];
        const path = m[2];
        // Azure DevOps SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
        const ado = path.match(/^v3\/([^/]+)\/([^/]+)\/([^/]+)$/);
        if (ado && /^ssh\.dev\.azure\.com$/i.test(host)) {
            return `https://dev.azure.com/${ado[1]}/${ado[2]}/_git/${ado[3]}`;
        }
        return `https://${host}/${path}`;
    }
    return null;
}

async function addAccountFlow(tokens: TokenStore, tree: PrTreeProvider): Promise<void> {
    const provider = await vscode.window.showQuickPick(
        PROVIDERS.map(p => ({ label: p.label, provider: p })),
        { placeHolder: "Provider", ignoreFocusOut: true }
    );
    if (!provider) { return; }
    const p = provider.provider;

    const label = await vscode.window.showInputBox({
        prompt: "Account label (display only)",
        placeHolder: "e.g. Work, Personal, Acme",
        ignoreFocusOut: true,
    });
    if (!label) { return; }

    const baseUrl = await vscode.window.showInputBox({
        prompt: "Base URL",
        value: p.defaultBaseUrl,
        ignoreFocusOut: true,
    });
    if (!baseUrl) { return; }

    const extra: Record<string, string> = {};
    if (p.needsExtra === "workspace") {
        const ws = await vscode.window.showInputBox({
            prompt: "Bitbucket workspace slug",
            placeHolder: "e.g. acme-team",
            ignoreFocusOut: true,
        });
        if (!ws) { return; }
        extra.workspace = ws;
    } else if (p.needsExtra === "organization") {
        const org = await vscode.window.showInputBox({
            prompt: "Azure DevOps organization slug",
            placeHolder: "e.g. acme",
            ignoreFocusOut: true,
        });
        if (!org) { return; }
        extra.organization = org;
    }

    const token = await vscode.window.showInputBox({
        prompt: p.tokenPrompt,
        password: true,
        ignoreFocusOut: true,
    });
    if (!token) { return; }

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
        { placeHolder: "Account to remove", ignoreFocusOut: true }
    );
    if (!pick) { return; }
    const confirm = await vscode.window.showWarningMessage(
        `Remove "${pick.account.label}"? Token will be deleted from SecretStorage.`,
        { modal: true },
        "Remove"
    );
    if (confirm !== "Remove") { return; }
    await removeAccount(pick.account.id);
    await tokens.delete(pick.account.id);
    tree.refresh();
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}
