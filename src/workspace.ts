import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { Account, RepoRef } from "./providers/types";
import { getClient } from "./providers";

const execAsync = promisify(exec);

export interface WorkspaceRepo {
    folder: vscode.WorkspaceFolder;
    /** Raw remote URL from `git config --get remote.origin.url`. */
    remoteUrl: string;
    /** First account whose provider parsed the remote URL successfully. */
    account: Account;
    /** Provider-specific repo reference. */
    ref: RepoRef;
}

/** A workspace folder we found, but whose remote doesn't match any configured account. */
export interface UnmatchedRepo {
    folder: vscode.WorkspaceFolder;
    remoteUrl: string;
}

export interface WorkspaceScan {
    repos: WorkspaceRepo[];
    unmatched: UnmatchedRepo[];
    /** Folders that aren't git repos or have no `origin` remote. */
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
        // Not a git repo, no origin remote, git missing — caller treats as "skipped".
        return null;
    }
}

export async function scanWorkspace(accounts: Account[]): Promise<WorkspaceScan> {
    const folders = vscode.workspace.workspaceFolders ?? [];
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
        let matched = false;
        for (const acc of accounts) {
            const client = getClient(acc.kind);
            const ref = client.parseRepoUrl(url, acc);
            if (ref) {
                repos.push({ folder, remoteUrl: url, account: acc, ref });
                matched = true;
                break;
            }
        }
        if (!matched) {
            unmatched.push({ folder, remoteUrl: url });
        }
    }

    return { repos, unmatched, skipped };
}
