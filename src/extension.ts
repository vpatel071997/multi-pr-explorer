import * as vscode from "vscode";
import { TokenStore } from "./auth";
import {
    addAccount,
    listAccounts,
    removeAccount,
    getRefreshIntervalMinutes,
    listIssueOverrides,
    IssueOverride,
} from "./config";
import { PrTreeProvider } from "./tree";
import { Account, ProviderKind, PullItem } from "./providers/types";
import { scanWorkspace, WorkspaceRepo } from "./workspace";

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
        vscode.commands.registerCommand("multiPrExplorer.mapIssueTracker", (node?: { repo?: WorkspaceRepo }) =>
            mapIssueTrackerFlow(tokens, tree, node?.repo)
        ),
        vscode.commands.registerCommand("multiPrExplorer.manageIssueTrackers", () =>
            manageIssueTrackerFlow(tree)
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

// ── Issue tracker mapping wizard ──────────────────────────────────────────────

async function mapIssueTrackerFlow(
    tokens: TokenStore,
    tree: PrTreeProvider,
    presetRepo?: WorkspaceRepo,
): Promise<void> {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        vscode.window.showErrorMessage("Add at least one account first.");
        return;
    }

    // Step 1: pick a repo (skip if invoked from a repo-node context menu).
    let repo: WorkspaceRepo | undefined = presetRepo;
    if (!repo) {
        const scan = await scanWorkspace(accounts);
        if (scan.repos.length === 0) {
            vscode.window.showErrorMessage("No matched workspace repos. Open a folder whose remote matches a configured account first.");
            return;
        }
        const pick = await vscode.window.showQuickPick(
            scan.repos.map(r => ({
                label: r.ref.displayName,
                description: `${r.account.label} • ${r.account.kind}`,
                detail: r.remoteUrl,
                repo: r,
            })),
            { placeHolder: "Which workspace repo should use a different issue tracker?", ignoreFocusOut: true }
        );
        if (!pick) { return; }
        repo = pick.repo;
    }

    // Step 2: scope — this repo only, or all repos at this host.
    const host = hostOf(repo.remoteUrl);
    const scopePick = await vscode.window.showQuickPick(
        [
            { label: `Just this repo`, description: repo.ref.displayName, scope: "repo" as const },
            { label: `All repos at ${host}`, description: "broader override; first-match-wins ordering applies", scope: "host" as const },
        ],
        { placeHolder: "How broadly should this override apply?", ignoreFocusOut: true }
    );
    if (!scopePick) { return; }
    const matches = scopePick.scope === "repo"
        ? trimRemoteForMatch(repo.remoteUrl)
        : host;

    // Step 3: pick the issue account.
    const accPick = await vscode.window.showQuickPick(
        accounts.map(a => ({
            label: a.label,
            description: `${a.kind} • ${shortHost(a.baseUrl)}`,
            account: a,
        })),
        { placeHolder: "Which account should provide issues for this repo?", ignoreFocusOut: true }
    );
    if (!accPick) { return; }
    const target = accPick.account;

    // Step 4: ADO needs a Team Project; for other kinds, skip.
    let project: string | undefined;
    if (target.kind === "azure") {
        project = await pickAdoProject(target, tokens);
        if (!project) { return; }
    }

    // Step 5: persist (User scope, dedupe-by-matches).
    const cfg = vscode.workspace.getConfiguration("multiPrExplorer");
    const current: IssueOverride[] = cfg.get<IssueOverride[]>("issueTrackerMap") ?? [];
    const filtered = current.filter(o => o.matches.toLowerCase() !== matches.toLowerCase());
    const newEntry: IssueOverride = { matches, account: target.label, ...(project ? { project } : {}) };
    filtered.unshift(newEntry);
    await cfg.update("issueTrackerMap", filtered, vscode.ConfigurationTarget.Global);

    tree.refresh();
    vscode.window.showInformationMessage(
        `Mapped: ${matches} → ${target.label}${project ? ` / ${project}` : ""}`
    );
}

async function manageIssueTrackerFlow(tree: PrTreeProvider): Promise<void> {
    const overrides = listIssueOverrides();
    if (overrides.length === 0) {
        vscode.window.showInformationMessage(
            "No issue tracker overrides configured. Use 'Multi-PR: Map Issue Tracker…' to add one."
        );
        return;
    }
    const pick = await vscode.window.showQuickPick(
        overrides.map(o => ({
            label: `${o.matches} → ${o.account}${o.project ? ` / ${o.project}` : ""}`,
            override: o,
        })),
        { placeHolder: "Select an override to remove", ignoreFocusOut: true }
    );
    if (!pick) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Remove override "${pick.label}"?`,
        { modal: true },
        "Remove"
    );
    if (confirm !== "Remove") { return; }

    const cfg = vscode.workspace.getConfiguration("multiPrExplorer");
    const current: IssueOverride[] = cfg.get<IssueOverride[]>("issueTrackerMap") ?? [];
    const filtered = current.filter(o =>
        !(o.matches === pick.override.matches &&
          o.account === pick.override.account &&
          (o.project ?? "") === (pick.override.project ?? ""))
    );
    await cfg.update("issueTrackerMap", filtered, vscode.ConfigurationTarget.Global);
    tree.refresh();
    vscode.window.showInformationMessage("Override removed.");
}

/** Try to enumerate ADO projects via API; fall back to manual InputBox on any failure. */
async function pickAdoProject(account: Account, tokens: TokenStore): Promise<string | undefined> {
    const token = await tokens.get(account.id);
    const org = account.extra?.organization;
    if (!token || !org) {
        return vscode.window.showInputBox({
            prompt: "Azure DevOps Team Project name",
            ignoreFocusOut: true,
        });
    }
    try {
        const base = account.baseUrl.replace(/\/+$/, "");
        const url = `${base}/${encodeURIComponent(org)}/_apis/projects?api-version=7.1&$top=200`;
        const auth = "Basic " + Buffer.from(":" + token).toString("base64");
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) { throw new Error(`${res.status}: ${await res.text()}`); }
        const data = (await res.json()) as { value: { name: string }[] };
        const names = data.value.map(p => p.name).sort((a, b) => a.localeCompare(b));
        if (names.length === 0) {
            return vscode.window.showInputBox({
                prompt: "Azure DevOps Team Project name (no projects returned by API)",
                ignoreFocusOut: true,
            });
        }
        return vscode.window.showQuickPick(names, {
            placeHolder: `Select Team Project from ${org} (${names.length} found)`,
            ignoreFocusOut: true,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return vscode.window.showInputBox({
            prompt: `Couldn't list ADO projects (${msg}). Enter the project name manually.`,
            ignoreFocusOut: true,
        });
    }
}

// ── Helpers used by the wizards ──────────────────────────────────────────────

function hostOf(url: string): string {
    const stripped = url.replace(/^[^@]+@/, "").replace(/^https?:\/\//i, "");
    return stripped.split(/[/:]/)[0].toLowerCase();
}

function shortHost(url: string): string {
    return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

/** Build a "this repo only" matches substring from a remote URL: host + path. */
function trimRemoteForMatch(url: string): string {
    const cleaned = url
        .replace(/^[^@]+@/, "")          // ssh user@
        .replace(/^https?:\/\//i, "")    // http(s)://
        .replace(/\.git$/, "")           // .git suffix
        .replace(/\/+$/, "")             // trailing slashes
        .replace(":", "/");              // ssh host:path → host/path
    return cleaned.toLowerCase();
}
