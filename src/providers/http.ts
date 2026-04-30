/**
 * Detailed result of an authenticated GET probe. Used by verifyToken to keep
 * URL + status + response body together so the user can debug from the tree's
 * error tooltip alone.
 */
export interface ProbeResult {
    ok: boolean;
    status?: number;
    /** First N characters of the response body for diagnostics. */
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
        if (res.ok) {
            return { ok: true, status: res.status };
        }
        let body = "";
        try { body = await res.text(); } catch { /* ignore */ }
        return { ok: false, status: res.status, bodySnippet: body.slice(0, 300) };
    } catch (e) {
        return { ok: false, cause: describeFetchError(e) };
    }
}

/**
 * Unwrap Node 18+ fetch errors. The top-level Error usually says just
 * "fetch failed"; the actionable detail (DNS code, TLS reason, etc.) is on
 * `error.cause`. Surfacing both lets the user see e.g.
 *   "fetch failed: ENOTFOUND gitlab.acme.internal"
 * instead of just "fetch failed".
 */
export function describeFetchError(e: unknown): string {
    if (e instanceof Error) {
        const cause = (e as { cause?: unknown }).cause;
        if (cause instanceof Error) {
            const code = (cause as { code?: string }).code;
            return code ? `${e.message}: ${code} ${cause.message}` : `${e.message}: ${cause.message}`;
        }
        if (cause && typeof cause === "object") {
            const code = (cause as { code?: string }).code;
            const message = (cause as { message?: string }).message;
            const parts = [code, message].filter(Boolean).join(" ");
            return parts ? `${e.message}: ${parts}` : e.message;
        }
        return e.message;
    }
    return String(e);
}
