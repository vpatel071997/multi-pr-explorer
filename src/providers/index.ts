import { ProviderClient, ProviderKind } from "./types";
import { GitHubClient } from "./github";
import { GitLabClient } from "./gitlab";
import { BitbucketClient } from "./bitbucket";
import { AzureClient } from "./azure";

export function getClient(kind: ProviderKind): ProviderClient {
    switch (kind) {
        case "github":
            return new GitHubClient();
        case "gitlab":
            return new GitLabClient();
        case "bitbucket":
            return new BitbucketClient();
        case "azure":
            return new AzureClient();
    }
}
