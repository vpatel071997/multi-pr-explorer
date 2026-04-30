import * as vscode from "vscode";
import { Account } from "./providers/types";

const SECTION = "multiPrExplorer";
const KEY = "accounts";

export function listAccounts(): Account[] {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const raw = cfg.get<Account[]>(KEY) ?? [];
    return raw.filter(a => a && a.id && a.kind && a.label);
}

export async function saveAccounts(accounts: Account[], target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    await cfg.update(KEY, accounts, target);
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
