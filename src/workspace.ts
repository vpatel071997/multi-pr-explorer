import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { Account, RepoRef } from "./providers/types";
import { getClient } from "./providers";
import { findAccountByRef, IssueOverride, listIssueOverrides } from "./config";

const execAsync = promisify(exec);

export interface WorkspaceRepo {
    folder: vscode.WorkspaceFolder;
    /** Raw remote URL from `git config --get remote.origin.url`. */
    remoteUrl: string;
    /** Account whose provider parsed the remote URL — used for the Pull Requests section. */
    account: Account;
    /** RepoRef built by that provider. */
    ref: RepoRef;
    /** Account used for the Issues section. Defaults to `account`; differs when an override matches. */
    issueAccount: Account;
    /** RepoRef used for the Issues section. May be synthetic (e.g. ADO project-only ref). */
    issueRef: RepoRef;
    /** True when the issue source comes from a multiPrExplorer.issueTrackerMap override. */
    issueOverridden: boolean;
}

export interface UnmatchedRepo {
    folder: vscode.WorkspaceFolder;
    remoteUrl: string;
}

export interface WorkspaceScan {
    repos: WorkspaceRepo[];
    unmatched: UnmatchedRepo[];
    skipped: vscode.WorkspaceFolder[];
}

async function getOriginUrl(folder: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync("git config --get remote.origin.url", {
            cwd: folder,
            windowsHide: true,
            timeout: 10_000,
        });
        const trimmed = stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}

/** Build the RepoRef the issue provider should query, given the override entry. */
function buildIssueRef(target: Account, override: IssueOverride, fallback: RepoRef): RepoRef {
    if (target.kind === "azure") {
        const project = (override.project ?? "").trim();
        const org = (target.extra?.organization ?? "").trim();
        if (!project || !org) {
            // Fall back to the original ref so the user sees a clear error from
            // the ADO client about the missing project.
            return fallback;
        }
        return {
            url: `<override:${target.id}:${project}>`,
            displayName: `${org}/${project} (issues)`,
            path: { org, project, repo: "(no repo)" },
        };
    }
    // Other provider kinds aren't supported as override targets in v0.4 —
    // fall back to the original ref so the user sees that path.
    return fallback;
}

function findOverride(remoteUrl: string, overrides: IssueOverride[]): IssueOverride | undefined {
    const lower = remoteUrl.toLowerCase();
    return overrides.find(o => lower.includes(o.matches.toLowerCase()));
}

export async function scanWorkspace(accounts: Account[]): Promise<WorkspaceScan> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const overrides = listIssueOverrides();
    const repos: WorkspaceRepo[] = [];
    const unmatched: UnmatchedRepo[] = [];
    const skipped: vscode.WorkspaceFolder[] = [];

    for (const folder of folders) {
        if (folder.uri.scheme !== "file") {
            skipped.push(folder);
            continue;
        }
        const url = await getOriginUrl(folder.uri.fsPath);
        if (!url) {
            skipped.push(folder);
            continue;
        }
        let prAccount: Account | null = null;
        let prRef: RepoRef | null = null;
        for (const acc of accounts) {
            const client = getClient(acc.kind);
            const ref = client.parseRepoUrl(url, acc);
            if (ref) {
                prAccount = acc;
                prRef = ref;
                break;
            }
        }
        if (!prAccount || !prRef) {
            unmatched.push({ folder, remoteUrl: url });
            continue;
        }

        let issueAccount = prAccount;
        let issueRef = prRef;
        let issueOverridden = false;
        const ov = findOverride(url, overrides);
        if (ov) {
            const target = findAccountByRef(ov.account, accounts);
            if (target) {
                issueAccount = target;
                issueRef = buildIssueRef(target, ov, prRef);
                issueOverridden = true;
            }
            // else: override references an unknown account — silently fall back.
            // The README notes this; we surface no error here because the
            // user will simply see the default-account issues, prompting them
            // to fix the typo.
        }

        repos.push({
            folder,
            remoteUrl: url,
            account: prAccount,
            ref: prRef,
            issueAccount,
            issueRef,
            issueOverridden,
        });
    }

    return { repos, unmatched, skipped };
}
