import { context, redis, scheduler, UserSocialLink } from "@devvit/web/server";
import { addHours, addMinutes, addSeconds, format, subMinutes, subMonths, subWeeks } from "date-fns";
import { ALL_POTENTIAL_USER_PREFIXES, ControlSubredditJob, domainFromUrl, expireKeyAt, getDataStoreFiltered, hGetAllChunked, hMGetAsRecord, hSetChunked, SOCIAL_LINKS_STORE, zRangeAsRecord } from "../..";
import { FLAGS_TO_EXCLUDE_FROM_STATS, userIsBanned } from "./statsHelpers";
import { getEvaluatorVariable, getRedisSubstitionValue, setRedisSubstititionValue } from "../../userEvaluation";
import json2md from "json2md";
import { compact, uniq } from "lodash-es";
import { AsyncWikiUpdateJobData, SocialLinksStatisticsJobData } from "../../../tasks";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";

export function cleanLink (input: string): string {
    if (!input.includes("onlyfans.com") && !input.includes("fansly.com") && !input.includes("fans.ly") && !input.includes("snapchat.com") && !input.includes("fanvue.com")) {
        return input;
    }

    let newString = input;
    if (newString.startsWith("https://www.")) {
        newString = newString.replace("https://www.", "https://");
    }

    if (newString.startsWith("https://onlyfans.com/action/trial")) {
        return newString;
    }

    const linkRegex = /^(https:\/\/(?:onlyfans\.com|fansly\.com|fans\.ly)\/[\w\d.-]+\/)(?:[ct]\d+|trial)/;
    const matches = linkRegex.exec(newString);
    if (matches?.[1]) {
        newString = matches[1];
    }

    const snapchatRegex = /^(https:\/\/(?:www\.)?snapchat\.com\/add\/[\w\d._-]+)(?:\?share.*)?/;
    const snapchatMatches = snapchatRegex.exec(newString);
    if (snapchatMatches?.[1]) {
        newString = snapchatMatches[1];
    }

    if (!newString.endsWith("/")) {
        newString += "/";
    }

    const fanvueRegex1 = /^(https:\/\/www.fanvue.com\/[\w.-]+\/).+/;
    const fanvueMatches = fanvueRegex1.exec(input);
    if (fanvueMatches?.[1]) {
        newString = fanvueMatches[1];
    }

    const fanvueRegex2 = /^(https:\/\/www.fanvue.com\/[\w.-]+)\?.+/;
    const fanvueMatches2 = fanvueRegex2.exec(input);
    if (fanvueMatches2?.[1]) {
        newString = fanvueMatches2[1];
    }

    return newString;
}

interface SocialLinksEntry {
    hits: number;
    coveredByEvaluator: boolean;
    firstSeen?: number;
    lastSeen?: number;
    usernames: string[];
}

interface SocialLinksQueueEntry {
    username: string;
    reportedAt: number;
}

const SOCIAL_LINKS_USER_QUEUE = "SocialLinksUserQueue";
const SOCIAL_LINKS_STATS_STORE = "SocialLinksStatsStore";
const SOCIAL_LINKS_DOMAIN_FIRST_SEEN_STORE = "SocialLinksDomainFirstSeenStore";
const IN_PROGRESS_KEY = "SocialLinksInProgress";
const STUCK_JOB_KEY = "SocialLinksStuckJob";

export async function socialLinksStatisticsJobRunner () {
    if (await redis.exists(IN_PROGRESS_KEY)) {
        console.log("Social Links: Job already in progress, skipping.");
        return;
    }

    await redis.set(IN_PROGRESS_KEY, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });
    await redis.del(SOCIAL_LINKS_USER_QUEUE, SOCIAL_LINKS_STATS_STORE);

    await scheduler.runJob<SocialLinksStatisticsJobData>({
        name: ControlSubredditJob.SocialLinksStatistics,
        runAt: new Date(),
        data: {
            jobGuid: crypto.randomUUID(),
            phase: "initialise",
            firstRun: true,
            prefixes: ALL_POTENTIAL_USER_PREFIXES,
        },
    });
}

export async function handleSocialLinksStatisticsInitialise (data: SocialLinksStatisticsJobData) {
    const runLimit = addSeconds(new Date(), 10);
    if (!data.prefixes) {
        throw new Error("No prefixes provided for Social Links initialisation");
    }

    console.log(`Social Links: Initialising with ${data.prefixes.length} prefixes`);

    await redis.set(IN_PROGRESS_KEY, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });
    await redis.set(STUCK_JOB_KEY, Date.now().toString(), { expiration: addMinutes(new Date(), 30) });

    while (data.prefixes.length > 0 && new Date() < runLimit) {
        const prefix = data.prefixes.shift();
        if (!prefix) {
            break;
        }

        const dataForPrefix = await getDataStoreFiltered(prefix, {
            since: subMonths(new Date(), 3),
            statuses: [UserStatus.Banned, UserStatus.Purged],
            omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
        });

        const allEntries = Object.entries(dataForPrefix)
            .filter(([, value]) => userIsBanned(value) && value.reportedAt)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            .map(([key, value]) => ({ username: key, reportedAt: value.reportedAt! } satisfies SocialLinksQueueEntry));

        if (allEntries.length === 0) {
            continue;
        }

        await redis.zAdd(SOCIAL_LINKS_USER_QUEUE, ...allEntries.map(item => ({ member: JSON.stringify(item), score: item.reportedAt })));
    }

    await expireKeyAt(SOCIAL_LINKS_USER_QUEUE, addHours(new Date(), 1));

    if (data.prefixes.length > 0) {
        await scheduler.runJob<SocialLinksStatisticsJobData>({
            name: ControlSubredditJob.SocialLinksStatistics,
            runAt: new Date(),
            data: {
                jobGuid: crypto.randomUUID(),
                phase: "initialise",
                firstRun: false,
                prefixes: data.prefixes,
            },
        });
    } else {
        await scheduler.runJob<SocialLinksStatisticsJobData>({
            name: ControlSubredditJob.SocialLinksStatistics,
            runAt: new Date(),
            data: {
                jobGuid: crypto.randomUUID(),
                phase: "process",
                firstRun: true,
            },
        });
    }
}

export async function handleSocialLinksStatisticsProcess (data: SocialLinksStatisticsJobData) {
    console.log("Social Links: Handling process phase");

    await redis.set(IN_PROGRESS_KEY, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });
    await redis.set(STUCK_JOB_KEY, Date.now().toString(), { expiration: addMinutes(new Date(), 30) });
    const processQueue = await redis.zRange(SOCIAL_LINKS_USER_QUEUE, 0, 39999)
        .then(items => items.map(item => JSON.parse(item.member) as SocialLinksQueueEntry));

    if (processQueue.length === 0) {
        console.log("Social Links: No entries to process, finalising statistics");
        await redis.del(STUCK_JOB_KEY);

        if (data.firstRun) {
            console.error("Social Links: No entries to process on first run, something might be wrong with the initial data.");
            return;
        }

        await scheduler.runJob<SocialLinksStatisticsJobData>({
            name: ControlSubredditJob.SocialLinksStatistics,
            runAt: new Date(),
            data: {
                jobGuid: crypto.randomUUID(),
                phase: "finalise",
                firstRun: true,
            },
        });

        return;
    }

    const runLimit = addSeconds(new Date(), 15);

    const socialLinks = await hMGetAsRecord(redis, SOCIAL_LINKS_STORE, processQueue.map(item => item.username));
    const existingStatsStore = await hGetAllChunked(redis, SOCIAL_LINKS_STATS_STORE);

    const filteredQueue = processQueue.filter(item => socialLinks[item.username]);
    const entriesToRemove = processQueue.filter(item => !socialLinks[item.username]);

    console.log(`Social Links: Processing ${filteredQueue.length} entries, ${entriesToRemove.length} have no link`);

    const configuredLinks = await getEvaluatorVariable<string[]>("sociallinks:badlinks") ?? [];
    const ignoredLinks = await getEvaluatorVariable<string[]>("sociallinks:ignored") ?? [];

    const domainFirstSeenEntries = await zRangeAsRecord(redis, SOCIAL_LINKS_DOMAIN_FIRST_SEEN_STORE, 0, -1);
    const domainFirstSeenEntriesToStore: Record<string, number> = {};

    while (filteredQueue.length > 0 && new Date() < runLimit) {
        const firstEntry = processQueue.shift();
        if (!firstEntry) {
            break;
        }

        const userSocialLinkData = socialLinks[firstEntry.username];
        if (!userSocialLinkData) {
            entriesToRemove.push(firstEntry);
            continue;
        }

        const userSocialLinks = JSON.parse(userSocialLinkData) as UserSocialLink[];

        const domainsProcessedForUser = new Set<string>();

        for (const link of uniq(userSocialLinks.map(link => cleanLink(link.outboundUrl)))) {
            if (ignoredLinks.some(ignoredLink => new RegExp(ignoredLink).test(link))) {
                continue;
            }

            let domain: string | undefined;
            try {
                domain = domainFromUrl(link);
                if (domain && !domainFirstSeenEntries[domain] && !domainsProcessedForUser.has(domain)) {
                    domainFirstSeenEntriesToStore[domain] = firstEntry.reportedAt;
                    domainFirstSeenEntries[domain] = firstEntry.reportedAt;
                }
                if (domain) {
                    domainsProcessedForUser.add(domain);
                }
            } catch {
                console.error(`Social Links: Failed to process link ${link}`);
            }

            const existingEntry = existingStatsStore[link];
            if (existingEntry) {
                const existingEntryParsed = JSON.parse(existingEntry) as SocialLinksEntry;
                existingEntryParsed.hits += 1;
                existingEntryParsed.firstSeen = existingEntryParsed.firstSeen ? Math.min(existingEntryParsed.firstSeen, firstEntry.reportedAt) : firstEntry.reportedAt;
                existingEntryParsed.lastSeen = existingEntryParsed.lastSeen ? Math.max(existingEntryParsed.lastSeen, firstEntry.reportedAt) : firstEntry.reportedAt;
                existingEntryParsed.usernames = [...existingEntryParsed.usernames, firstEntry.username].slice(-5);
                existingStatsStore[link] = JSON.stringify(existingEntryParsed);
            } else {
                const newEntry: SocialLinksEntry = {
                    hits: 1,
                    coveredByEvaluator: configuredLinks.some(configuredLink => link.startsWith(configuredLink)),
                    firstSeen: firstEntry.reportedAt,
                    lastSeen: firstEntry.reportedAt,
                    usernames: [firstEntry.username],
                };
                existingStatsStore[link] = JSON.stringify(newEntry);
            }
        }

        entriesToRemove.push(firstEntry);
    }

    if (entriesToRemove.length > 0) {
        await redis.zRem(SOCIAL_LINKS_USER_QUEUE, entriesToRemove.map(entry => JSON.stringify(entry)));
    }

    await hSetChunked(redis, SOCIAL_LINKS_STATS_STORE, existingStatsStore);

    const firstSeenEntriesToStore = Object.entries(domainFirstSeenEntriesToStore).map(([domain, firstSeen]) => ({ score: firstSeen, member: domain }));
    if (firstSeenEntriesToStore.length > 0) {
        await redis.zAdd(SOCIAL_LINKS_DOMAIN_FIRST_SEEN_STORE, ...firstSeenEntriesToStore);
    }

    await scheduler.runJob<SocialLinksStatisticsJobData>({
        name: ControlSubredditJob.SocialLinksStatistics,
        runAt: addSeconds(new Date(), 2),
        data: {
            jobGuid: crypto.randomUUID(),
            phase: "process",
            firstRun: false,
        },
    });
}

export async function handleSocialLinksStatisticsFinalise () {
    console.log("Social Links: Finalising statistics");

    const storedRecords = await hGetAllChunked(redis, SOCIAL_LINKS_STATS_STORE);
    const domainFirstSeenEntries = await redis.zRange(SOCIAL_LINKS_DOMAIN_FIRST_SEEN_STORE, subWeeks(new Date(), 2).getTime(), Date.now(), { by: "score" });

    const bareDomainRegex = /^https?:\/\/\w+\.\w+\\?$/;

    const records = Array.from(Object.entries(storedRecords)
        .map(([link, value]) => ({ link, value: JSON.parse(value) as SocialLinksEntry })))
        .filter(item => item.value.hits > 2 && !bareDomainRegex.test(item.link))
        .sort((a, b) => a.link > b.link ? 1 : -1)
        .sort((a, b) => b.value.hits - a.value.hits);

    const wikiContent: json2md.DataObject[] = [
        { p: "This page lists social links seen on more than two users, where it has been seen on a newly banned user in the last three months" },
        { p: "Note: OnlyFans links have been cleaned to remove share codes and trial invites." },
    ];

    if (records.length === 0) {
        wikiContent.push({ p: "No social links found more than twice with a hit in the last three months." });
    } else {
        const coveredByEvaluatorRows: string[][] = [];
        const notCoveredByEvaluatorRows: string[][] = [];

        const headers = ["Link", "Hit count", "First Seen", "Last Seen", "Example Users"];

        for (const record of records) {
            const recordRow = [
                record.link,
                record.value.hits.toLocaleString(),
                record.value.firstSeen ? format(record.value.firstSeen, "MMM dd") : "",
                record.value.lastSeen ? format(record.value.lastSeen, "MMM dd") : "",
                uniq(record.value.usernames).map(username => `/u/${username}`).join(", "),
            ];

            if (record.value.coveredByEvaluator) {
                coveredByEvaluatorRows.push(recordRow);
            } else {
                notCoveredByEvaluatorRows.push(recordRow);
            }
        }

        wikiContent.push({ h2: "Links not covered by Evaluator configuration" });
        if (notCoveredByEvaluatorRows.length > 0) {
            wikiContent.push({ p: "No action is needed on these. They will be automatically added to the config within an hour." });
            wikiContent.push({ table: { headers, rows: notCoveredByEvaluatorRows } });
        } else {
            wikiContent.push({ p: "None!" });
        }

        wikiContent.push({ h2: "Links covered by Evaluator configuration" });
        if (coveredByEvaluatorRows.length > 0) {
            wikiContent.push({ table: { headers, rows: coveredByEvaluatorRows } });
        } else {
            wikiContent.push({ p: "None!" });
        }
    }

    if (domainFirstSeenEntries.length > 0) {
        const domainFirstSeenMap = new Map<string, Date>();
        for (const entry of domainFirstSeenEntries) {
            const domain = entry.member;
            const firstSeen = new Date(entry.score);
            domainFirstSeenMap.set(domain, firstSeen);
        }

        const domainCounts: Record<string, number> = {};
        const domainUsers = new Map<string, string[]>();

        for (const link of Object.keys(storedRecords)) {
            try {
                const domain = domainFromUrl(link);
                if (domain) {
                    domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
                    if (domainFirstSeenMap.has(domain)) {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        const data = JSON.parse(storedRecords[link]!) as SocialLinksEntry;
                        const lastUsername = data.usernames[data.usernames.length - 1];
                        if (lastUsername) {
                            const existingUsers = domainUsers.get(domain) ?? [];
                            existingUsers.push(lastUsername);
                            domainUsers.set(domain, uniq(existingUsers).slice(-5));
                        }
                    }
                }
            } catch {
                // Likely malformed URL, ignore it
            }
        }

        wikiContent.push({ h2: "Newly seen domains" });
        wikiContent.push({ p: "Newly seen domains in the last two weeks on more than one user:" });
        const domainHeaders = ["Domain", "First seen", "Count", "Example users"];
        const domainRows = domainFirstSeenEntries.map((entry) => {
            const count = domainCounts[entry.member] ?? 0;
            if (count < 2) {
                return;
            }
            const exampleUsers = uniq(domainUsers.get(entry.member) ?? []);
            if (exampleUsers.length < 2) {
                return;
            }
            return [entry.member, format(new Date(entry.score), "yyyy-MM-dd"), count.toLocaleString(), exampleUsers.map(username => `u/${username}`).join(", ")];
        });

        wikiContent.push({ table: { headers: domainHeaders, rows: compact(domainRows) } });
    }

    const configuredLinks = await getEvaluatorVariable<string[]>("sociallinks:badlinks") ?? [];
    if (configuredLinks.length > 0) {
        const bullets: string[] = [];
        for (const link of configuredLinks) {
            if (!records.some(record => record.link.startsWith(link))) {
                bullets.push(link);
            }
        }

        if (bullets.length > 0) {
            wikiContent.push({ h2: "Links in Evaluator Configuration but not seen recently" });
            wikiContent.push({ p: "The following links are in the Evaluator Configuration but have not been seen in the last four weeks:" });
            wikiContent.push({ ul: bullets });
        }
    }

    const wikiPageName = "statistics/social-links";

    await scheduler.runJob<AsyncWikiUpdateJobData>({
        name: ControlSubredditJob.AsyncWikiUpdate,
        runAt: addSeconds(new Date(), 1),
        data: {
            jobGuid: crypto.randomUUID(),
            subredditName: context.subredditName,
            page: wikiPageName,
            content: json2md(wikiContent),
        },
    });

    const domainOnlyUrlRegex = /^https?:\/\/[^/]+\/?$/;
    const newSubstitionValue = records.map(record => record.link).filter(link => !domainOnlyUrlRegex.test(link));
    const existingSubstitionValue = new Set(await getRedisSubstitionValue<string[]>("sociallinks") ?? []);

    if (newSubstitionValue.length === existingSubstitionValue.size && newSubstitionValue.every(value => existingSubstitionValue.has(value))) {
        return;
    }

    await setRedisSubstititionValue("sociallinks", newSubstitionValue);
    console.log(`Updated social links substitution value with ${newSubstitionValue.length} entries`);
    await redis.del(IN_PROGRESS_KEY, SOCIAL_LINKS_USER_QUEUE, SOCIAL_LINKS_STATS_STORE);
}

export async function resumeSocialLinksJob () {
    const stuckJobTimestampData = await redis.get(STUCK_JOB_KEY);
    if (!stuckJobTimestampData) {
        return;
    }

    const stuckJobTimeStamp = new Date(parseInt(stuckJobTimestampData, 10));
    if (stuckJobTimeStamp < subMinutes(new Date(), 3)) {
        await scheduler.runJob({
            name: ControlSubredditJob.SocialLinksStatistics,
            runAt: new Date(),
        });
    }
}
