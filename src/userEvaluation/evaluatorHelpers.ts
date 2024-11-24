export function domainFromUrl (url: string): string | undefined {
    if (url.startsWith("/")) {
        // Reddit internal link
        return;
    }

    const hostname = new URL(url).hostname;
    const trimmedHostname = hostname.startsWith("www.") ? hostname.substring(4) : hostname;

    return trimmedHostname;
}
