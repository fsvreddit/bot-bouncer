import { WikiPagePermissionLevel } from "@devvit/public-api";
import type { JobContext, TriggerContext, UserSocialLink } from "@devvit/public-api";
import { format, subDays } from "date-fns";
import json2md from "json2md";
import _ from "lodash";
import crypto from "crypto";
import { ControlSubredditJob } from "./constants.js";
import { getInitialAccountProperties, getInitialAccountPropertiesForUsers, UserFlag, UserStatus } from "./dataStore.js";
import type { InitialAccountProperties, UserDetails } from "./dataStore.js";
import { domainFromUrl } from "./utility.js";
import { hSetChunked } from "./redisHelper.js";
import type { StatsUserEntry } from "./scheduler/sixHourlyJobs.js";
import { userIsBanned } from "./statistics/statsHelpers.js";

export const HACKED_PROFILE_FINGERPRINT_OBSERVATION_STORE = "HackedProfileFingerprintObservations";
export const HACKED_PROFILE_FINGERPRINT_FEATURE_BANK_STORE = "HackedProfileFingerprintFeatureBank";

const LOOKBACK_DAYS = 90;
const MAX_EXAMPLE_USERS = 5;
const MAX_RECOVERED_BACKFILL_USERS = 100;
const MAX_SCAMMED_BACKFILL_USERS = 50;
const MAX_ORGANIC_COMPARISON_USERS = 50;
const MAX_BANNED_COMPARISON_USERS = 50;

type HackedProfileOutcomeClass = "recovered" | "organic_non_recovered" | "banned_non_recovered" | "scammed" | "other";
type HackedProfileFeatureType = "bioHash" | "displayNameHash" | "socialDomain" | "socialHandle" | "socialLinkHash";

export interface HackedProfileFeatures {
    bioHash?: string;
    displayNameHash?: string;
    socialDomains: string[];
    socialHandles: string[];
    socialLinkHashes: string[];
}

export interface HackedProfileFingerprintObservation {
    username: string;
    source: "statistics_backfill" | "summary_lookup";
    observedAt: number;
    reportedAt?: number;
    lastUpdate: number;
    status: UserStatus;
    flags: UserFlag[];
    outcomeClass: HackedProfileOutcomeClass;
    features: HackedProfileFeatures;
}

export interface HackedProfileFeatureBankRecord {
    featureKey: string;
    featureType: HackedProfileFeatureType;
    featureValue: string;
    recoveredUsers: number;
    organicNonRecoveredUsers: number;
    bannedNonRecoveredUsers: number;
    scammedUsers: number;
    otherUsers: number;
    lastSeen: number;
    exampleRecoveredUsers: string[];
    exampleOrganicUsers: string[];
    exampleBannedUsers: string[];
    exampleScammedUsers: string[];
}

interface FeatureMatch {
    record: HackedProfileFeatureBankRecord;
    score: number;
}

interface HackedProfileSummaryMatch {
    confidence: "weak" | "moderate" | "strong";
    matches: FeatureMatch[];
}

function sha256 (input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeText (input: string): string {
    return input.trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizeUrl (input: string): string | undefined {
    try {
        const url = new URL(input);
        const hostname = url.hostname.startsWith("www.") ? url.hostname.substring(4) : url.hostname;
        const path = url.pathname.replace(/\/+$/u, "");
        return `${url.protocol}//${hostname.toLowerCase()}${path.toLowerCase()}`;
    } catch {
        return undefined;
    }
}

function extractHandleFromUrl (input: string): string | undefined {
    const normalizedUrl = normalizeUrl(input);
    if (!normalizedUrl) {
        return;
    }

    const url = new URL(normalizedUrl);
    const pathSegments = url.pathname.split("/").map(segment => segment.trim()).filter(Boolean);
    const lastSegment = pathSegments.at(-1)?.replace(/^@/u, "");
    if (!lastSegment) {
        return;
    }

    if (!/^[\w.-]{3,40}$/u.test(lastSegment) || !/[a-z]/iu.test(lastSegment)) {
        return;
    }

    const commonSegments = new Set(["add", "profile", "user", "users", "share", "invite", "trial", "action"]);
    if (commonSegments.has(lastSegment.toLowerCase())) {
        return;
    }

    return lastSegment.toLowerCase();
}

function socialLinkUrls (socialLinks: UserSocialLink[]): string[] {
    return _.compact(socialLinks.map(link => link.outboundUrl));
}

export function getHackedProfileFeatures (profile: InitialAccountProperties): HackedProfileFeatures {
    const normalizedBio = profile.bioText ? normalizeText(profile.bioText) : undefined;
    const normalizedDisplayName = profile.displayName ? normalizeText(profile.displayName) : undefined;
    const urls = socialLinkUrls(profile.socialLinks);

    return {
        bioHash: normalizedBio && normalizedBio.length >= 4 ? sha256(normalizedBio) : undefined,
        displayNameHash: normalizedDisplayName && normalizedDisplayName.length >= 3 ? sha256(normalizedDisplayName) : undefined,
        socialDomains: _.uniq(_.compact(urls.map(domainFromUrl))).sort(),
        socialHandles: _.uniq(_.compact(urls.map(extractHandleFromUrl))).sort(),
        socialLinkHashes: _.uniq(_.compact(urls.map(normalizeUrl)).map(sha256)).sort(),
    };
}

function featureKey (featureType: HackedProfileFeatureType, featureValue: string): string {
    return `${featureType}:${featureValue}`;
}

export function getHackedProfileFeatureKeys (features: HackedProfileFeatures): string[] {
    const keys: string[] = [];
    if (features.bioHash) {
        keys.push(featureKey("bioHash", features.bioHash));
    }
    if (features.displayNameHash) {
        keys.push(featureKey("displayNameHash", features.displayNameHash));
    }
    keys.push(...features.socialDomains.map(domain => featureKey("socialDomain", domain)));
    keys.push(...features.socialHandles.map(handle => featureKey("socialHandle", handle)));
    keys.push(...features.socialLinkHashes.map(hash => featureKey("socialLinkHash", hash)));

    return _.uniq(keys);
}

function parseFeatureKey (key: string): { featureType: HackedProfileFeatureType; featureValue: string } {
    const index = key.indexOf(":");
    const featureType = key.substring(0, index) as HackedProfileFeatureType;
    const featureValue = key.substring(index + 1);

    return { featureType, featureValue };
}

function getOutcomeClass (details: UserDetails): HackedProfileOutcomeClass {
    if (details.flags?.includes(UserFlag.HackedAndRecovered)) {
        return "recovered";
    }
    if (details.flags?.includes(UserFlag.Scammed)) {
        return "scammed";
    }
    if (details.userStatus === UserStatus.Organic) {
        return "organic_non_recovered";
    }
    if (userIsBanned(details)) {
        return "banned_non_recovered";
    }

    return "other";
}

function appendExampleUser (users: string[], username: string): string[] {
    if (users.includes(username)) {
        return users;
    }

    return [...users, username].slice(-MAX_EXAMPLE_USERS);
}

function hasAnyFeatures (features: HackedProfileFeatures): boolean {
    return getHackedProfileFeatureKeys(features).length > 0;
}

function buildObservation (username: string, details: UserDetails, profile: InitialAccountProperties, source: HackedProfileFingerprintObservation["source"]): HackedProfileFingerprintObservation | undefined {
    const features = getHackedProfileFeatures(profile);
    if (!hasAnyFeatures(features)) {
        return;
    }

    return {
        username,
        source,
        observedAt: new Date().getTime(),
        reportedAt: details.reportedAt,
        lastUpdate: details.lastUpdate,
        status: details.userStatus,
        flags: details.flags ?? [],
        outcomeClass: getOutcomeClass(details),
        features,
    };
}

function lastProfileObservationTime (entry: StatsUserEntry): number {
    return entry.data.reportedAt ?? entry.data.lastUpdate;
}

function newestEntries (entries: StatsUserEntry[], limit: number): StatsUserEntry[] {
    return [...entries]
        .sort((a, b) => lastProfileObservationTime(b) - lastProfileObservationTime(a))
        .slice(0, limit);
}

function selectHackedProfileFingerprintBackfillEntries (recentEntries: StatsUserEntry[]): StatsUserEntry[] {
    const recoveredEntries = recentEntries.filter(entry => entry.data.flags?.includes(UserFlag.HackedAndRecovered));
    const scammedEntries = recentEntries.filter(entry => entry.data.flags?.includes(UserFlag.Scammed));
    const organicEntries = recentEntries.filter(entry => entry.data.userStatus === UserStatus.Organic && !entry.data.flags?.includes(UserFlag.HackedAndRecovered));
    const bannedEntries = recentEntries.filter(entry => userIsBanned(entry.data) && !entry.data.flags?.includes(UserFlag.HackedAndRecovered));

    return _.uniqBy([
        ...newestEntries(recoveredEntries, MAX_RECOVERED_BACKFILL_USERS),
        ...newestEntries(scammedEntries, MAX_SCAMMED_BACKFILL_USERS),
        ...newestEntries(organicEntries, MAX_ORGANIC_COMPARISON_USERS),
        ...newestEntries(bannedEntries, MAX_BANNED_COMPARISON_USERS),
    ], entry => entry.username);
}

export function buildHackedProfileFeatureBank (observations: HackedProfileFingerprintObservation[]): Record<string, HackedProfileFeatureBankRecord> {
    const records: Record<string, HackedProfileFeatureBankRecord> = {};

    for (const observation of observations) {
        const keys = getHackedProfileFeatureKeys(observation.features);
        for (const key of keys) {
            const parsedKey = parseFeatureKey(key);
            const existingRecord = records[key] ?? {
                featureKey: key,
                featureType: parsedKey.featureType,
                featureValue: parsedKey.featureValue,
                recoveredUsers: 0,
                organicNonRecoveredUsers: 0,
                bannedNonRecoveredUsers: 0,
                scammedUsers: 0,
                otherUsers: 0,
                lastSeen: 0,
                exampleRecoveredUsers: [],
                exampleOrganicUsers: [],
                exampleBannedUsers: [],
                exampleScammedUsers: [],
            };

            if (observation.outcomeClass === "recovered") {
                existingRecord.recoveredUsers += 1;
                existingRecord.exampleRecoveredUsers = appendExampleUser(existingRecord.exampleRecoveredUsers, observation.username);
            } else if (observation.outcomeClass === "organic_non_recovered") {
                existingRecord.organicNonRecoveredUsers += 1;
                existingRecord.exampleOrganicUsers = appendExampleUser(existingRecord.exampleOrganicUsers, observation.username);
            } else if (observation.outcomeClass === "banned_non_recovered") {
                existingRecord.bannedNonRecoveredUsers += 1;
                existingRecord.exampleBannedUsers = appendExampleUser(existingRecord.exampleBannedUsers, observation.username);
            } else if (observation.outcomeClass === "scammed") {
                existingRecord.scammedUsers += 1;
                existingRecord.exampleScammedUsers = appendExampleUser(existingRecord.exampleScammedUsers, observation.username);
            } else {
                existingRecord.otherUsers += 1;
            }

            existingRecord.lastSeen = Math.max(existingRecord.lastSeen, observation.reportedAt ?? observation.lastUpdate);
            records[key] = existingRecord;
        }
    }

    return records;
}

function readableFeatureName (record: Pick<HackedProfileFeatureBankRecord, "featureType" | "featureValue">): string {
    if (record.featureType === "bioHash") {
        return `bio hash ${record.featureValue.substring(0, 12)}`;
    }
    if (record.featureType === "displayNameHash") {
        return `display-name hash ${record.featureValue.substring(0, 12)}`;
    }
    if (record.featureType === "socialDomain") {
        return `social domain ${record.featureValue}`;
    }
    if (record.featureType === "socialHandle") {
        return `social handle token ${record.featureValue}`;
    }

    return `social-link hash ${record.featureValue.substring(0, 12)}`;
}

function featureScore (record: HackedProfileFeatureBankRecord): number {
    const comparisonUsers = record.organicNonRecoveredUsers + record.scammedUsers;
    let score = record.recoveredUsers * 25;
    score -= comparisonUsers * 30;
    score -= record.bannedNonRecoveredUsers * 5;

    if (record.featureType === "socialDomain") {
        score += 10;
    }
    if (record.featureType === "socialHandle") {
        score += 15;
    }
    if (record.featureType === "bioHash" || record.featureType === "displayNameHash") {
        score += 5;
    }

    return score;
}

function candidateConfidence (record: HackedProfileFeatureBankRecord): "weak" | "moderate" | "strong" | undefined {
    if (record.recoveredUsers >= 5 && record.organicNonRecoveredUsers === 0 && record.scammedUsers === 0) {
        return "strong";
    }
    if (record.recoveredUsers >= 3 && record.organicNonRecoveredUsers <= 1 && record.recoveredUsers > record.organicNonRecoveredUsers + record.scammedUsers) {
        return "moderate";
    }
    if (record.recoveredUsers >= 2 && record.recoveredUsers > record.organicNonRecoveredUsers + record.scammedUsers) {
        return "weak";
    }

    return undefined;
}

function getStrongestSummaryMatch (records: HackedProfileFeatureBankRecord[]): HackedProfileSummaryMatch | undefined {
    const matches = records
        .filter(record => candidateConfidence(record) !== undefined)
        .map(record => ({ record, score: featureScore(record) }))
        .sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
        return;
    }

    const strongMatches = matches.filter(match => candidateConfidence(match.record) === "strong");
    const moderateMatches = matches.filter(match => candidateConfidence(match.record) === "moderate");

    let confidence: HackedProfileSummaryMatch["confidence"] = "weak";
    if (strongMatches.length > 0 || moderateMatches.length >= 2) {
        confidence = "strong";
    } else if (moderateMatches.length > 0 || matches.length >= 2) {
        confidence = "moderate";
    }

    return {
        confidence,
        matches: matches.slice(0, 5),
    };
}

function formatExampleUsers (users: string[]): string {
    return users.map(username => `/u/${username}`).join(", ");
}

function reportRows (records: HackedProfileFeatureBankRecord[], minimumConfidence: "moderate" | "strong"): string[][] {
    return records
        .filter(record => {
            const confidence = candidateConfidence(record);
            if (minimumConfidence === "strong") {
                return confidence === "strong";
            }
            return confidence === "moderate";
        })
        .sort((a, b) => featureScore(b) - featureScore(a))
        .slice(0, 50)
        .map(record => [
            readableFeatureName(record),
            record.recoveredUsers.toLocaleString(),
            record.organicNonRecoveredUsers.toLocaleString(),
            record.bannedNonRecoveredUsers.toLocaleString(),
            record.scammedUsers.toLocaleString(),
            record.lastSeen ? format(record.lastSeen, "MMM dd") : "",
            formatExampleUsers(record.exampleRecoveredUsers),
        ]);
}

function buildReport (observations: HackedProfileFingerprintObservation[], bank: Record<string, HackedProfileFeatureBankRecord>): json2md.DataObject[] {
    const records = Object.values(bank);
    const outcomeCounts = _.countBy(observations.map(observation => observation.outcomeClass));
    const strongRows = reportRows(records, "strong");
    const moderateRows = reportRows(records, "moderate");
    const headers = ["Feature", "Recovered", "Organic", "Banned non-recovered", "Scammed", "Last seen", "Recovered examples"];

    const content: json2md.DataObject[] = [
        { h1: "Hacked Profile Fingerprints" },
        { p: `This page is generated from a capped sample of stored public profile data for accounts reported in the last ${LOOKBACK_DAYS} days. It is intended for moderator review and appeal triage only.` },
        { p: "The page compares features from accounts marked recovered against organic, banned non-recovered, and scammed accounts. Raw bio and display-name text are not duplicated here; those features are represented by hashes." },
        { h2: "Backfill status" },
        {
            ul: [
                `Users with profile features processed: ${observations.length.toLocaleString()}`,
                `Recovered accounts: ${(outcomeCounts.recovered ?? 0).toLocaleString()}`,
                `Organic non-recovered accounts: ${(outcomeCounts.organic_non_recovered ?? 0).toLocaleString()}`,
                `Banned non-recovered accounts: ${(outcomeCounts.banned_non_recovered ?? 0).toLocaleString()}`,
                `Scammed accounts: ${(outcomeCounts.scammed ?? 0).toLocaleString()}`,
                `Generated: ${new Date().toUTCString()}`,
            ],
        },
        { h2: "Strong candidate features" },
    ];

    if (strongRows.length > 0) {
        content.push({ table: { headers, rows: strongRows } });
    } else {
        content.push({ p: "None found." });
    }

    content.push({ h2: "Moderate candidate features" });
    if (moderateRows.length > 0) {
        content.push({ table: { headers, rows: moderateRows } });
    } else {
        content.push({ p: "None found." });
    }

    content.push(
        { h2: "Use guidance" },
        {
            ul: [
                "Treat these matches as supporting evidence only.",
                "Do not automatically grant or deny an appeal based on this page.",
                "Keep scammed/promotion-stopped accounts separate from recovered accounts when reviewing candidates.",
                "Inspect recovered examples before adding any pattern to appeal config.",
            ],
        },
    );

    return content;
}

async function setModsOnlyWikiPage (page: string, context: JobContext) {
    try {
        await context.reddit.updateWikiPageSettings({
            subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
            page,
            listed: true,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    } catch (error) {
        console.warn(`Hacked Profile Fingerprints: Failed to update wiki settings for ${page}`, error);
    }
}

export async function updateHackedProfileFingerprintStatistics (allEntries: StatsUserEntry[], context: JobContext) {
    const since = subDays(new Date(), LOOKBACK_DAYS).getTime();
    const recentEligibleEntries = allEntries
        .filter(entry => lastProfileObservationTime(entry) >= since)
        .filter(entry => [UserStatus.Banned, UserStatus.Organic, UserStatus.Purged, UserStatus.Retired, UserStatus.Inactive].includes(entry.data.userStatus));
    const recentEntries = selectHackedProfileFingerprintBackfillEntries(recentEligibleEntries);

    console.log(`Hacked Profile Fingerprints: Processing ${recentEntries.length} capped users from ${recentEligibleEntries.length} recent eligible users for profile features.`);

    const observations: HackedProfileFingerprintObservation[] = [];
    for (const chunk of _.chunk(recentEntries, 250)) {
        const profiles = await getInitialAccountPropertiesForUsers(chunk.map(entry => entry.username), context);
        for (const entry of chunk) {
            const profile = profiles[entry.username];
            const observation = buildObservation(entry.username, entry.data, profile, "statistics_backfill");
            if (observation) {
                observations.push(observation);
            }
        }
    }

    const bank = buildHackedProfileFeatureBank(observations);
    const observationData = Object.fromEntries(observations.map(observation => [observation.username, JSON.stringify(observation)]));
    const bankData = Object.fromEntries(Object.entries(bank).map(([key, record]) => [key, JSON.stringify(record)]));

    await context.redis.del(HACKED_PROFILE_FINGERPRINT_OBSERVATION_STORE, HACKED_PROFILE_FINGERPRINT_FEATURE_BANK_STORE);
    if (Object.keys(observationData).length > 0) {
        await hSetChunked(context.redis, HACKED_PROFILE_FINGERPRINT_OBSERVATION_STORE, observationData);
    }
    if (Object.keys(bankData).length > 0) {
        await hSetChunked(context.redis, HACKED_PROFILE_FINGERPRINT_FEATURE_BANK_STORE, bankData);
    }

    const page = "statistics/hacked-profile-fingerprints";
    await context.scheduler.runJob({
        name: ControlSubredditJob.AsyncWikiUpdate,
        data: {
            subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
            page,
            content: json2md(buildReport(observations, bank)),
        },
        runAt: new Date(),
    });
    await setModsOnlyWikiPage(page, context);

    console.log(`Hacked Profile Fingerprints: Stored ${observations.length} observations and ${Object.keys(bank).length} feature records.`);
}

export async function getHackedProfileFingerprintSummary (username: string, userStatus: UserDetails | undefined, context: TriggerContext): Promise<json2md.DataObject[]> {
    if (!userStatus) {
        return [];
    }

    const profile = await getInitialAccountProperties(username, context);
    const features = getHackedProfileFeatures(profile);
    const keys = getHackedProfileFeatureKeys(features);
    if (keys.length === 0) {
        return [];
    }

    const rawRecords = await context.redis.hMGet(HACKED_PROFILE_FINGERPRINT_FEATURE_BANK_STORE, keys);
    const records = _.compact(rawRecords.map(record => record ? JSON.parse(record) as HackedProfileFeatureBankRecord : undefined));
    const summaryMatch = getStrongestSummaryMatch(records);
    if (!summaryMatch) {
        return [];
    }

    const bullets = summaryMatch.matches.map(match => {
        const record = match.record;
        return `${readableFeatureName(record)} — recovered: ${record.recoveredUsers.toLocaleString()}, organic: ${record.organicNonRecoveredUsers.toLocaleString()}, banned non-recovered: ${record.bannedNonRecoveredUsers.toLocaleString()}, scammed: ${record.scammedUsers.toLocaleString()}`;
    });

    return [
        { h2: "Hacked-account fingerprint" },
        { p: `${_.capitalize(summaryMatch.confidence)} match. This account's stored original public profile matches feature(s) previously seen on accounts marked recovered or compromise-related.` },
        { ul: bullets },
        { p: "Interpretation: supporting evidence only. This does not prove the account was hacked; review the appeal and recent activity before granting or denying the appeal." },
    ];
}
