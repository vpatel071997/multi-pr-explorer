import { ProviderClient, ProviderKind } from "./types";
import { GitHubClient } from "./github";
import { GitLabClient } from "./gitlab";
import { BitbucketClient } from "./bitbucket";
import { AzureClient } from "./azure";

// Cache instances so providers can hold per-account state across calls
// (e.g. the authenticated username Bitbucket needs to filter assigned issues).
const cache = new Map<ProviderKind, ProviderClient>();

export function getClient(kind: ProviderKind): ProviderClient {
    let c = cache.get(kind);
    if (c) { return c; }
    switch (kind) {
        case "github":    c = new GitHubClient(); break;
        case "gitlab":    c = new GitLabClient(); break;
        case "bitbucket": c = new BitbucketClient(); break;
        case "azure":     c = new AzureClient(); break;
    }
    cache.set(kind, c);
    return c;
}
