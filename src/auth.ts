import * as vscode from "vscode";

const SECRET_PREFIX = "multiPrExplorer.token.";

/** Token store backed by VS Code SecretStorage. Keyed by Account.id. */
export class TokenStore {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async get(accountId: string): Promise<string | undefined> {
        return this.secrets.get(SECRET_PREFIX + accountId);
    }

    async set(accountId: string, token: string): Promise<void> {
        await this.secrets.store(SECRET_PREFIX + accountId, token);
    }

    async delete(accountId: string): Promise<void> {
        await this.secrets.delete(SECRET_PREFIX + accountId);
    }
}
