import * as vscode from "vscode";
import { Account } from "./providers/types";

const SECTION = "multiPrExplorer";

export function listAccounts(): Account[] {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const raw = cfg.get<Account[]>("accounts") ?? [];
    return raw.filter(a => a && a.id && a.kind && a.label);
}

export async function saveAccounts(accounts: Account[], target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    await cfg.update("accounts", accounts, target);
}

export async function addAccount(account: Account): Promise<void> {
    const accounts = listAccounts();
    if (accounts.some(a => a.id === account.id)) {
        throw new Error(`An account with id "${account.id}" already exists.`);
    }
    accounts.push(account);
    await saveAccounts(accounts);
}

export async function removeAccount(id: string): Promise<void> {
    const accounts = listAccounts().filter(a => a.id !== id);
    await saveAccounts(accounts);
}

/** Per-repo issue-tracker override. See package.json `multiPrExplorer.issueTrackerMap`. */
export interface IssueOverride {
    /** Substring matched (case-insensitive) against the git remote URL. */
    matches: string;
    /** Account label or id. */
    account: string;
    /** Azure DevOps Team Project name; required when target account is `azure`. */
    project?: string;
}

export function listIssueOverrides(): IssueOverride[] {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return (cfg.get<IssueOverride[]>("issueTrackerMap") ?? []).filter(o => o && o.matches && o.account);
}

export function findAccountByRef(ref: string, accounts: Account[]): Account | undefined {
    // Match by id first (stable), fall back to label (user-friendly).
    return accounts.find(a => a.id === ref) ?? accounts.find(a => a.label === ref);
}

export function getRefreshIntervalMinutes(): number {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const v = cfg.get<number>("refreshIntervalMinutes") ?? 0;
    return v > 0 ? v : 0;
}
