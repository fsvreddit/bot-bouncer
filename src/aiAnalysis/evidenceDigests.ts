export interface EvaluationResultLike {
    botName: string;
    hitReason?: string | {
        reason: string;
        details: Array<{ key: string; value: string }>;
    };
    canAutoBan: boolean;
    metThreshold: boolean;
}

export interface AIHistoryBase {
    id: string;
    type: "comment" | "post";
    createdAt: Date;
    subredditName: string;
    karma: number;
    edited?: boolean;
}

export interface AICommentHistoryItem extends AIHistoryBase {
    type: "comment";
    content: string;
    postId: string;
    parentId: string;
    isTopLevel: boolean;
    parentPostInfo?: {
        title: string;
        createdAt: Date;
        url?: string;
    };
}

export interface AIPostHistoryItem extends AIHistoryBase {
    type: "post";
    title: string;
    content?: string;
    url?: string;
    isPinnedToProfile?: boolean;
    nsfw?: boolean;
}

export type AIHistoryItem = AICommentHistoryItem | AIPostHistoryItem;

export interface HistoryCoverage {
    contentLimit: number;
    totalItemsRetrieved: number;
    commentsRetrieved: number;
    postsRetrieved: number;
    oldestItemAt?: Date;
    newestItemAt?: Date;
    combinedLimitReached: boolean;
    failedParentPostLookups: number;
}

export interface ProfileSnapshot {
    bio?: string;
    displayName?: string;
    socialLinkUrls: string[];
}

export interface ProfileChanges {
    bio?: { original?: string; current?: string };
    displayName?: { original?: string; current?: string };
    socialLinks?: {
        added: string[];
        removed: string[];
    };
}

export interface PromotionDigest {
    domains?: Array<{
        domain: string;
        occurrences: number;
        locations: string[];
    }>;
    contactHandles?: Array<{
        value: string;
        occurrences: number;
        locations: string[];
    }>;
    referralIndicators?: Array<{
        parameter: string;
        occurrences: number;
    }>;
}

export interface ReuseDigest {
    exactTitleClusters?: Array<{
        representativeText: string;
        occurrences: number;
        subredditCount: number;
        firstSeenAt: Date;
        lastSeenAt: Date;
    }>;
    exactCommentClusters?: Array<{
        representativeText: string;
        occurrences: number;
        subredditCount: number;
        firstSeenAt: Date;
        lastSeenAt: Date;
    }>;
    repeatedMediaUrls?: Array<{
        url: string;
        occurrences: number;
    }>;
}

export interface CompactEvaluationResult {
    botName: string;
    description?: string;
    reason?: string;
    details?: Array<{ key: string; value: string }>;
    canAutoBan: boolean;
    metThreshold: boolean;
}

export interface EvaluatorChangeDigest {
    initial: CompactEvaluationResult[];
    current: CompactEvaluationResult[];
    persistentEvaluatorNames: string[];
    resolvedEvaluatorNames: string[];
    newlyMatchedEvaluatorNames: string[];
}

const MAX_EXCERPT_LENGTH = 180;
const MAX_REASON_LENGTH = 300;
const MAX_DETAIL_LENGTH = 180;
const MAX_DIGEST_ITEMS = 10;
const REFERRAL_PARAMETERS = new Set(["aff", "affiliate", "code", "coupon", "invite", "ref", "referral", "tag"]);

function nonEmptyString (value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function truncate (value: string, maxLength: number): string {
    const compact = value.replace(/\s+/gu, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function normalizeText (value: string): string {
    return value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/\s+/gu, " ")
        .trim();
}

function sortedUnique (values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function buildHistoryCoverage (
    history: AIHistoryItem[],
    contentLimit: number,
    failedParentPostLookups: number
): HistoryCoverage {
    const sortedDates = history.map(item => item.createdAt).sort((a, b) => a.getTime() - b.getTime());

    return {
        contentLimit,
        totalItemsRetrieved: history.length,
        commentsRetrieved: history.filter(item => item.type === "comment").length,
        postsRetrieved: history.filter(item => item.type === "post").length,
        oldestItemAt: sortedDates[0],
        newestItemAt: sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : undefined,
        combinedLimitReached: history.length >= contentLimit,
        failedParentPostLookups,
    };
}

export function buildProfileChanges (original: ProfileSnapshot, current: ProfileSnapshot): ProfileChanges | undefined {
    const changes: ProfileChanges = {};

    const originalBio = nonEmptyString(original.bio);
    const currentBio = nonEmptyString(current.bio);
    if (originalBio !== undefined && originalBio !== currentBio) {
        changes.bio = { original: originalBio, current: currentBio };
    }

    const originalDisplayName = nonEmptyString(original.displayName);
    const currentDisplayName = nonEmptyString(current.displayName);
    if (originalDisplayName !== undefined && originalDisplayName !== currentDisplayName) {
        changes.displayName = { original: originalDisplayName, current: currentDisplayName };
    }

    const originalLinks = sortedUnique(original.socialLinkUrls);
    const currentLinks = sortedUnique(current.socialLinkUrls);
    const added = currentLinks.filter(link => !originalLinks.includes(link));
    const removed = originalLinks.filter(link => !currentLinks.includes(link));
    if (added.length > 0 || removed.length > 0) {
        changes.socialLinks = { added, removed };
    }

    return Object.keys(changes).length > 0 ? changes : undefined;
}

interface LocatedText {
    text: string;
    location: string;
}

function extractUrls (value: string): URL[] {
    const matches = value.match(/https?:\/\/[^\s<>()\[\]{}"']+/giu) ?? [];
    return matches.flatMap((match) => {
        try {
            return [new URL(match.replace(/[.,;:!?]+$/u, ""))];
        } catch {
            return [];
        }
    });
}

function extractHandles (value: string): string[] {
    const results: string[] = [];

    const labelledHandleRegex = /\b(?:discord|instagram|insta|lnstta|snap|snapchat|telegram|tg|whatsapp)\b\s*(?::|\/|@|-)\s*([a-z0-9_.-]{3,32})\b/giu;
    for (const match of value.matchAll(labelledHandleRegex)) {
        results.push(match[1].toLocaleLowerCase());
    }

    const atHandleRegex = /(^|[^\w.+-])@([a-z0-9_.-]{3,32})\b/giu;
    for (const match of value.matchAll(atHandleRegex)) {
        results.push(match[2].toLocaleLowerCase());
    }

    return results;
}

export function buildPromotionDigest (
    currentProfile: ProfileSnapshot,
    history: AIHistoryItem[]
): PromotionDigest | undefined {
    const locatedText: LocatedText[] = [];
    if (currentProfile.bio) {
        locatedText.push({ text: currentProfile.bio, location: "profile bio" });
    }
    for (const url of currentProfile.socialLinkUrls) {
        locatedText.push({ text: url, location: "profile social link" });
    }

    for (const item of history) {
        if (item.type === "comment") {
            locatedText.push({ text: item.content, location: "comment" });
        } else {
            locatedText.push({ text: item.title, location: "post title" });
            if (item.content) {
                locatedText.push({ text: item.content, location: "post body" });
            }
            if (item.url) {
                locatedText.push({ text: item.url, location: "post URL" });
            }
        }
    }

    const domainData = new Map<string, { occurrences: number; locations: Set<string> }>();
    const handleData = new Map<string, { occurrences: number; locations: Set<string> }>();
    const referralData = new Map<string, number>();

    for (const entry of locatedText) {
        for (const url of extractUrls(entry.text)) {
            const domain = url.hostname.toLocaleLowerCase().replace(/^www\./u, "");
            const current = domainData.get(domain) ?? { occurrences: 0, locations: new Set<string>() };
            current.occurrences++;
            current.locations.add(entry.location);
            domainData.set(domain, current);

            for (const parameter of url.searchParams.keys()) {
                const normalizedParameter = parameter.toLocaleLowerCase();
                if (REFERRAL_PARAMETERS.has(normalizedParameter)) {
                    referralData.set(normalizedParameter, (referralData.get(normalizedParameter) ?? 0) + 1);
                }
            }
        }

        for (const handle of extractHandles(entry.text)) {
            const current = handleData.get(handle) ?? { occurrences: 0, locations: new Set<string>() };
            current.occurrences++;
            current.locations.add(entry.location);
            handleData.set(handle, current);
        }
    }

    const digest: PromotionDigest = {};

    const domains = [...domainData.entries()]
        .filter(([domain]) => !domain.endsWith("reddit.com") && domain !== "redd.it")
        .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
        .slice(0, MAX_DIGEST_ITEMS)
        .map(([domain, data]) => ({ domain, occurrences: data.occurrences, locations: sortedUnique([...data.locations]) }));
    if (domains.length > 0) {
        digest.domains = domains;
    }

    const contactHandles = [...handleData.entries()]
        .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
        .slice(0, MAX_DIGEST_ITEMS)
        .map(([value, data]) => ({ value, occurrences: data.occurrences, locations: sortedUnique([...data.locations]) }));
    if (contactHandles.length > 0) {
        digest.contactHandles = contactHandles;
    }

    const referralIndicators = [...referralData.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_DIGEST_ITEMS)
        .map(([parameter, occurrences]) => ({ parameter, occurrences }));
    if (referralIndicators.length > 0) {
        digest.referralIndicators = referralIndicators;
    }

    return Object.keys(digest).length > 0 ? digest : undefined;
}

interface ReuseCandidate {
    text: string;
    normalized: string;
    subredditName: string;
    createdAt: Date;
}

function buildTextClusters (candidates: ReuseCandidate[]) {
    const clusters = new Map<string, ReuseCandidate[]>();
    for (const candidate of candidates) {
        if (candidate.normalized.length < 15) {
            continue;
        }
        const existing = clusters.get(candidate.normalized) ?? [];
        existing.push(candidate);
        clusters.set(candidate.normalized, existing);
    }

    return [...clusters.values()]
        .filter(items => items.length >= 2)
        .sort((a, b) => b.length - a.length || b[0].normalized.length - a[0].normalized.length)
        .slice(0, 5)
        .map((items) => {
            const ordered = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            return {
                representativeText: truncate(ordered[0].text, MAX_EXCERPT_LENGTH),
                occurrences: ordered.length,
                subredditCount: new Set(ordered.map(item => item.subredditName)).size,
                firstSeenAt: ordered[0].createdAt,
                lastSeenAt: ordered[ordered.length - 1].createdAt,
            };
        });
}

export function buildReuseDigest (history: AIHistoryItem[]): ReuseDigest | undefined {
    const titleCandidates: ReuseCandidate[] = history
        .filter((item): item is AIPostHistoryItem => item.type === "post")
        .map(item => ({ text: item.title, normalized: normalizeText(item.title), subredditName: item.subredditName, createdAt: item.createdAt }));

    const commentCandidates: ReuseCandidate[] = history
        .filter((item): item is AICommentHistoryItem => item.type === "comment")
        .map(item => ({ text: item.content, normalized: normalizeText(item.content), subredditName: item.subredditName, createdAt: item.createdAt }));

    const mediaCounts = new Map<string, number>();
    for (const item of history) {
        if (item.type === "post" && item.url && !item.url.includes("reddit.com/")) {
            mediaCounts.set(item.url, (mediaCounts.get(item.url) ?? 0) + 1);
        }
    }

    const digest: ReuseDigest = {};
    const exactTitleClusters = buildTextClusters(titleCandidates);
    if (exactTitleClusters.length > 0) {
        digest.exactTitleClusters = exactTitleClusters;
    }

    const exactCommentClusters = buildTextClusters(commentCandidates);
    if (exactCommentClusters.length > 0) {
        digest.exactCommentClusters = exactCommentClusters;
    }

    const repeatedMediaUrls = [...mediaCounts.entries()]
        .filter(([, occurrences]) => occurrences >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([url, occurrences]) => ({ url, occurrences }));
    if (repeatedMediaUrls.length > 0) {
        digest.repeatedMediaUrls = repeatedMediaUrls;
    }

    return Object.keys(digest).length > 0 ? digest : undefined;
}

function compactHitReason (result: EvaluationResultLike): Pick<CompactEvaluationResult, "reason" | "details"> {
    if (typeof result.hitReason === "string") {
        const reason = result.hitReason.replace(/(matched(?: bannable)? regex:)\s*[\s\S]+$/iu, "$1 [omitted; available in deterministic summary]");
        return { reason: truncate(reason, MAX_REASON_LENGTH) };
    }

    if (!result.hitReason) {
        return {};
    }

    const reason = result.hitReason.reason.replace(/(matched(?: bannable)? regex:)\s*[\s\S]+$/iu, "$1 [omitted; available in deterministic summary]");
    return {
        reason: truncate(reason, MAX_REASON_LENGTH),
        details: result.hitReason.details.slice(0, 8).map((detail: { key: string; value: string }) => ({
            key: truncate(detail.key, 80),
            value: truncate(detail.value, MAX_DETAIL_LENGTH),
        })),
    };
}

export function compactEvaluationResults (
    results: EvaluationResultLike[],
    evaluatorDescriptions: Record<string, string | undefined>
): CompactEvaluationResult[] {
    const seen = new Set<string>();
    const compactResults: CompactEvaluationResult[] = [];

    for (const result of results) {
        const compact: CompactEvaluationResult = {
            botName: result.botName,
            description: evaluatorDescriptions[result.botName],
            ...compactHitReason(result),
            canAutoBan: result.canAutoBan,
            metThreshold: result.metThreshold,
        };
        const key = JSON.stringify(compact);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        compactResults.push(compact);
        if (compactResults.length >= 20) {
            break;
        }
    }

    return compactResults;
}

export function buildEvaluatorChangeDigest (
    initial: EvaluationResultLike[],
    current: EvaluationResultLike[],
    evaluatorDescriptions: Record<string, string | undefined>
): EvaluatorChangeDigest {
    const initialNames = sortedUnique(initial.map(result => result.botName));
    const currentNames = sortedUnique(current.map(result => result.botName));

    return {
        initial: compactEvaluationResults(initial, evaluatorDescriptions),
        current: compactEvaluationResults(current, evaluatorDescriptions),
        persistentEvaluatorNames: initialNames.filter(name => currentNames.includes(name)),
        resolvedEvaluatorNames: initialNames.filter(name => !currentNames.includes(name)),
        newlyMatchedEvaluatorNames: currentNames.filter(name => !initialNames.includes(name)),
    };
}
