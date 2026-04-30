/**
 * Detailed result of an authenticated GET probe. Used by verifyToken to keep
 * URL + status + response body together so the user can debug from the tree's
 * error tooltip alone, and so the JSON body can be parsed without re-fetching.
 */
export interface ProbeResult {
    ok: boolean;
    status?: number;
    /** Full response body. Caller can JSON.parse on success. */
    bodyText?: string;
    /** First N characters of the response body, when !ok, for diagnostics. */
    bodySnippet?: string;
    /** Network/SSL/etc. error description when fetch threw rather than returning a response. */
    cause?: string;
}

/** Format a probe failure into a single human-readable line including the URL. */
export function describeProbe(p: ProbeResult, url: string): string {
    if (p.cause) {
        return `${p.cause} — ${url}`;
    }
    if (p.status !== undefined) {
        const body = p.bodySnippet
            ? ` — ${p.bodySnippet.replace(/\s+/g, " ").trim().slice(0, 160)}`
            : "";
        return `HTTP ${p.status}${body} — ${url}`;
    }
    return `unknown failure — ${url}`;
}

export async function probe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
    try {
        const res = await fetch(url, { headers });
        const bodyText = await res.text().catch(() => "");
        if (res.ok) {
            return { ok: true, status: res.status, bodyText };
        }
        return { ok: false, status: res.status, bodySnippet: bodyText.slice(0, 300) };
    } catch (e) {
        return { ok: false, cause: describeFetchError(e) };
    }
}

/**
 * Pull every diagnostic field we can find off a fetch-style error.
 *
 * Node 18+ wraps the real failure in `error.cause`. Some runtimes (older
 * embedded fetch, polyfills) don't populate `cause` and instead put `code`,
 * `errno`, `syscall`, `hostname` directly on the Error. Pull all of them so
 * the user sees something more actionable than "fetch failed".
 */
export function describeFetchError(e: unknown): string {
    if (!(e instanceof Error)) {
        return String(e);
    }
    const parts: string[] = [e.message];

    const cause = (e as { cause?: unknown }).cause;
    if (cause) {
        if (cause instanceof Error) {
            const causeCode = (cause as { code?: string }).code;
            parts.push(causeCode ? `${causeCode} ${cause.message}` : cause.message);
        } else if (typeof cause === "object") {
            const code = (cause as { code?: string }).code;
            const message = (cause as { message?: string }).message;
            const merged = [code, message].filter(Boolean).join(" ");
            if (merged) {
                parts.push(merged);
            } else {
                try {
                    const json = JSON.stringify(cause);
                    if (json && json !== "{}") { parts.push(json); }
                } catch { /* ignore */ }
            }
        } else {
            parts.push(String(cause));
        }
    } else {
        // No cause — scrape Node's typical syscall fields off the Error itself.
        const extras: string[] = [];
        const code = (e as { code?: string }).code;
        const errno = (e as { errno?: number | string }).errno;
        const syscall = (e as { syscall?: string }).syscall;
        const hostname = (e as { hostname?: string }).hostname;
        const address = (e as { address?: string }).address;
        const port = (e as { port?: number | string }).port;
        if (code) { extras.push(`code=${code}`); }
        if (errno !== undefined) { extras.push(`errno=${errno}`); }
        if (syscall) { extras.push(`syscall=${syscall}`); }
        if (hostname) { extras.push(`hostname=${hostname}`); }
        if (address) { extras.push(`address=${address}`); }
        if (port !== undefined) { extras.push(`port=${port}`); }
        if (extras.length > 0) {
            parts.push(extras.join(" "));
        }
    }

    return parts.join(": ");
}
