import { context, Post, reddit, redis, scheduler, TaskRequest, ZMember } from "@devvit/web/server";
import { addHours, addMinutes, addSeconds, format, subMinutes, subMonths, subWeeks } from "date-fns";
import { BIO_TEXT_STORE, ControlSubredditJob, DISPLAY_NAME_STORE, expireKeyAt, getDataStoreFiltered, hMGetAsRecord, USER_DEFINED_HANDLES_POSTS } from "../..";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { FLAGS_TO_EXCLUDE_FROM_STATS, userIsBanned } from "./statsHelpers";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import json2md from "json2md";
import { getEvaluatorVariable } from "../../userEvaluation";
import { parse } from "regjsparser";
import { AsyncWikiUpdateJobData, DefinedHandlesStatsInitializerJobData, DefinedHandlesStatsJobData, StoreDefinedHandlesDataJobData } from "../../../tasks";
import pluralize from "pluralize";
import { fromPairs } from "lodash-es";

const DEFINED_HANDLES_QUEUE = "definedHandlesQueue";
const DEFINED_HANDLES_DATA = "definedHandlesData";

interface DefinedHandleData {
    count: number;
    lastSeen: number;
    foundInBio: boolean;
    foundInDisplayName: boolean;
    foundInPosts: boolean;
    exampleUsers: string[];
}

interface UserDefinedHandlePost {
    handle: string;
    title: string;
    seen?: number;
}

const definedHandlesRecentlyRunKey = "definedHandlesStatsLastRunValue";
const DEFINED_HANDLES_LOOKBACK_MONTHS = 6;

export async function definedHandlesStatsInitializer (event: TaskRequest<DefinedHandlesStatsInitializerJobData>) {
    if (event.data.firstRun && await redis.exists(definedHandlesRecentlyRunKey)) {
        console.log("Defined Handles: Job ran recently; skipping this run.");
        return;
    }
    await redis.set(definedHandlesRecentlyRunKey, "1", { expiration: addMinutes(new Date(), 10) });

    console.log("Defined Handles: Starting initializer job for defined handles statistics.");
    if (event.data.firstRun) {
        await redis.del(DEFINED_HANDLES_QUEUE, DEFINED_HANDLES_DATA);
    }

    const runLimit = addSeconds(new Date(), 10);
    const { prefixes } = event.data;

    while (prefixes.length > 0 && new Date() < runLimit) {
        const prefix = prefixes.shift();
        if (!prefix) {
            break;
        }

        const dataForPrefix = await getDataStoreFiltered(prefix, {
            since: subMonths(new Date(), DEFINED_HANDLES_LOOKBACK_MONTHS),
            statuses: [UserStatus.Banned, UserStatus.Purged],
            omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
        });

        const filterdData = Object.entries(dataForPrefix)
            .filter(([, value]) => userIsBanned(value))
            .map(([username, value]) => ({ member: username, score: value.reportedAt ?? 0 } satisfies ZMember));

        await redis.zAdd(DEFINED_HANDLES_QUEUE, ...filterdData);
        await expireKeyAt(DEFINED_HANDLES_QUEUE, addHours(new Date(), 2));
    }

    if (prefixes.length > 0) {
        console.log(`Defined Handles: Not all prefixes processed; scheduling another initializer job for remaining ${prefixes.length} ${pluralize("prefix", prefixes.length)}.`);
        await scheduler.runJob<DefinedHandlesStatsInitializerJobData>({
            name: ControlSubredditJob.DefinedHandlesStatisticsInitialiser,
            runAt: addSeconds(new Date(), 5),
            data: {
                firstRun: false,
                prefixes,
                jobGuid: crypto.randomUUID(),
            },
        });
    } else {
        await scheduler.runJob<DefinedHandlesStatsJobData>({
            name: ControlSubredditJob.DefinedHandlesStatistics,
            runAt: addSeconds(new Date(), 5),
            data: { firstRun: true, jobGuid: crypto.randomUUID() },
        });
    }
}

const DEFINED_HANDLES_IN_PROGRESS_KEY = "DefinedHandlesInProgress";

export async function gatherDefinedHandlesStats (event: TaskRequest<DefinedHandlesStatsJobData>) {
    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 1) })) {
        console.error(`Defined Handles: Duplicate job with GUID ${jobGuid}!`);
        return;
    }

    const start = Date.now();
    const runLimit = addSeconds(new Date(), 15);

    const queuedHandles = await redis.zRange(DEFINED_HANDLES_QUEUE, 0, 9999);

    if (queuedHandles.length === 0) {
        await redis.del(DEFINED_HANDLES_IN_PROGRESS_KEY);
        if (event.data.firstRun) {
            console.error("Defined Handles: No defined handles found on first run.");
            return;
        }
        console.log("Defined Handles: No defined handles found in the queue.");
        await buildDefinedHandlesWikiPage();
        await redis.del(DEFINED_HANDLES_QUEUE, DEFINED_HANDLES_DATA);
        return;
    }

    await redis.set(definedHandlesRecentlyRunKey, "1", { expiration: addMinutes(new Date(), 10) });
    await redis.set(DEFINED_HANDLES_IN_PROGRESS_KEY, Date.now().toString(), { expiration: addHours(new Date(), 1) });

    let processedCount = 0;
    let withMatchesCount = 0;

    const processedUsers: string[] = [];

    const handlesList = event.data.handlesList ?? await getDefinedHandles();
    const handles = handlesList.map(handle => ({ handle, regex: new RegExp(`\\b${handle}\\b`, "u") }));

    if (handles.length === 0) {
        console.error("No defined handles found in evaluator variables.");
        return;
    }

    const existingDefinedHandles = await redis.hGetAll(DEFINED_HANDLES_DATA)
        .then(data => fromPairs(Object.entries(data).map(([handle, data]) => ([handle, JSON.parse(data) as DefinedHandleData]))));

    const definedHandlesDataToStore: Record<string, DefinedHandleData> = {};

    const [bioTexts, displayNames, userDefinedHandlesPosts] = await Promise.all([
        hMGetAsRecord(redis, BIO_TEXT_STORE, queuedHandles.map(handle => handle.member)),
        hMGetAsRecord(redis, DISPLAY_NAME_STORE, queuedHandles.map(handle => handle.member)),
        hMGetAsRecord(redis, USER_DEFINED_HANDLES_POSTS, queuedHandles.map(handle => handle.member)),
    ]);

    while (queuedHandles.length > 0 && new Date() < runLimit) {
        const firstItem = queuedHandles.shift();
        if (!firstItem) {
            console.log("Defined Handles: No more items in the queue to process.");
            break;
        }

        const username = firstItem.member;

        processedCount++;
        processedUsers.push(username);

        const userBioText = bioTexts[username];
        const userDisplayName = displayNames[username];
        const userDefinedHandlesData = userDefinedHandlesPosts[username];

        if (!userBioText && !userDisplayName && !userDefinedHandlesData) {
            processedUsers.push(username);
            continue;
        }

        let userDefinedHandles: UserDefinedHandlePost[] | undefined;
        if (userDefinedHandlesData) {
            userDefinedHandles = JSON.parse(userDefinedHandlesData) as UserDefinedHandlePost[];
        }

        const handlesFound = handles.map(handle => ({
            handle: handle.handle,
            foundInBio: userBioText !== undefined && handle.regex.test(userBioText),
            foundInDisplayName: userDisplayName !== undefined && handle.regex.test(userDisplayName),
            // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
            foundInPosts: userDefinedHandles !== undefined && userDefinedHandles.some(post => handle.regex.test(post.title)),
        })).filter(handle => handle.foundInBio || handle.foundInDisplayName || handle.foundInPosts);

        if (handlesFound.length > 0) {
            withMatchesCount++;
        }

        for (const handleEntry of handlesFound) {
            const existingData = existingDefinedHandles[handleEntry.handle] ?? { count: 0, lastSeen: 0, exampleUsers: [], foundInBio: false, foundInDisplayName: false, foundInPosts: false };
            existingData.count++;
            existingData.lastSeen = Math.max(existingData.lastSeen, firstItem.score);
            if (new Date(firstItem.score) > subWeeks(new Date(), 1)) {
                existingData.exampleUsers = [...existingData.exampleUsers.slice(-4), username];
            }
            existingData.foundInBio ||= handleEntry.foundInBio;
            existingData.foundInDisplayName ||= handleEntry.foundInDisplayName;
            existingData.foundInPosts ||= handleEntry.foundInPosts;
            existingDefinedHandles[handleEntry.handle] = existingData;
            definedHandlesDataToStore[handleEntry.handle] = existingData;
        }
    }

    if (processedUsers.length > 0) {
        await redis.zRem(DEFINED_HANDLES_QUEUE, processedUsers);
    }

    const entriesToStore = Object.entries(definedHandlesDataToStore).map(([handle, data]) => ([handle, JSON.stringify(data)]));
    if (entriesToStore.length > 0) {
        await redis.hSet(DEFINED_HANDLES_DATA, fromPairs(entriesToStore));
        await expireKeyAt(DEFINED_HANDLES_DATA, addMinutes(new Date(), 30));
    }

    const remainingHandles = await redis.zCard(DEFINED_HANDLES_QUEUE);
    console.log(`Defined Handles: Processed ${processedCount} users in ${(Date.now() - start).toLocaleString()}ms. With matches: ${withMatchesCount}. Remaining in queue: ${remainingHandles}.`);

    await scheduler.runJob<DefinedHandlesStatsJobData>({
        name: ControlSubredditJob.DefinedHandlesStatistics,
        runAt: addSeconds(new Date(), 1),
        data: { firstRun: false, jobGuid: crypto.randomUUID(), handlesList },
    });
}

function cleanHandleForSort (input: string): string {
    return input.replaceAll("\\b", "").replaceAll("[", "").replaceAll("(?:", "").replaceAll("(", "").toLowerCase();
}

async function buildDefinedHandlesWikiPage () {
    const existingDefinedHandlesData = await redis.hGetAll(DEFINED_HANDLES_DATA);
    const existingDefinedHandles = Object.entries(existingDefinedHandlesData).map(([handle, data]) => ({ handle, data: JSON.parse(data) as DefinedHandleData }));

    existingDefinedHandles.sort((a, b) => (cleanHandleForSort(a.handle) < cleanHandleForSort(b.handle) ? -1 : 1));

    const wikiContent: json2md.DataObject[] = [
        { h1: "Defined Handles Statistics" },
        { p: "This page lists defined handles that were hit on banned users within the last six months." },
        { p: "This page checks user bios, display names, and cached post-title hits." },
    ];

    const definedHandlesHitInLookback = existingDefinedHandles.filter(entry => entry.data.count > 0);
    const definedHandlesNotHitInLookback = existingDefinedHandles.filter(entry => entry.data.count === 0);

    const tableRows: string[][] = [];
    const tableHeaders = ["Handle", "Count", "Last Seen", "Found In", "Recent Example Users"];

    for (const entry of definedHandlesHitInLookback) {
        const { handle, data } = entry;

        const foundInText: string[] = [];
        if (data.foundInBio) {
            foundInText.push("Bio");
        }
        if (data.foundInDisplayName) {
            foundInText.push("Display Name");
        }
        if (data.foundInPosts) {
            foundInText.push("Posts");
        }

        tableRows.push([
            `\`${handle.replaceAll("|", "¦")}\``,
            data.count.toLocaleString(),
            data.lastSeen > 0 ? format(new Date(data.lastSeen), "yyyy-MM-dd") : "",
            foundInText.join(", "),
            data.exampleUsers.slice(-5).map(user => `/u/${user}`).join(", "),
        ]);
    }

    wikiContent.push({ h2: "Defined handles hit within the last six months" });
    if (tableRows.length > 0) {
        wikiContent.push({ table: { headers: tableHeaders, rows: tableRows } });
    } else {
        wikiContent.push({ p: "No defined handles found within the last six months." });
    }

    wikiContent.push({ h2: "Defined handles not hit within the last six months" });
    if (definedHandlesNotHitInLookback.length > 0) {
        wikiContent.push({ p: `\`${definedHandlesNotHitInLookback.map(entry => entry.handle).join("|")}\`` });
    } else {
        wikiContent.push({ p: "All defined handles were hit within the last six months." });
    }

    const suggestedHandles = definedHandlesHitInLookback
        .filter((entry) => {
            if (entry.data.count === 0) {
                return false;
            }

            if (entry.data.count === 1 && entry.data.lastSeen < subMonths(new Date(), 1).getTime()) {
                return false;
            }

            return true;
        })
        .map(entry => entry.handle)
        .join("|");

    wikiContent.push({ p: "Suggested handles for evaluation:" });
    wikiContent.push({ p: `\`${suggestedHandles}\`` });

    wikiContent.push({ p: "Existing defined handles, sorted:" });
    wikiContent.push({ p: `\`${existingDefinedHandles.map(entry => entry.handle).join("|")}\`` });

    await scheduler.runJob<AsyncWikiUpdateJobData>({
        name: ControlSubredditJob.AsyncWikiUpdate,
        runAt: new Date(),
        data: {
            jobGuid: crypto.randomUUID(),
            subredditName: context.subredditName,
            page: "statistics/definedhandles",
            content: json2md(wikiContent),
        },
    });

    await redis.del(definedHandlesRecentlyRunKey, DEFINED_HANDLES_DATA, DEFINED_HANDLES_QUEUE);
}

async function getDefinedHandles (): Promise<string[]> {
    const definedHandles = await getEvaluatorVariable<string>("substitutions:definedhandles") ?? "";
    if (definedHandles.length === 0) {
        return [];
    }

    const parsedHandles = parse(definedHandles, "u");
    if (parsedHandles.type !== "disjunction") {
        return [];
    }

    return parsedHandles.body.map(node => node.raw);
}

async function storeDefinedHandlesData (username: string) {
    let postHistory: Post[];
    try {
        postHistory = await reddit.getPostsByUser({
            username,
            sort: "new",
            limit: 100,
        }).all();
    } catch {
        // Likely shadowbanned or suspended already.
        return;
    }

    if (postHistory.length === 0) {
        return;
    }

    const handles = await getDefinedHandles();
    const foundHandles: UserDefinedHandlePost[] = [];

    for (const handle of handles) {
        const regex = new RegExp(`\\b${handle}\\b`, "u");
        const foundPost = postHistory.find(post => regex.test(post.title));
        if (foundPost) {
            foundHandles.push({
                handle,
                title: foundPost.title,
                seen: foundPost.createdAt.getTime(),
            });
        }
    }

    if (foundHandles.length > 0) {
        await redis.hSet(USER_DEFINED_HANDLES_POSTS, { [username]: JSON.stringify(foundHandles) });
        console.log(`Defined Handles: Stored defined handles posts for user ${username}: Found ${foundHandles.map(post => post.handle).join(", ")}`);
    }
}

export async function storeDefinedHandlesDataJob (event: TaskRequest<StoreDefinedHandlesDataJobData | undefined>) {
    const username = event.data?.username;
    if (!username) {
        console.error("No username provided in event data for storing defined handles data.");
        return;
    }

    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Store Defined Handles Data: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    await storeDefinedHandlesData(username);
}

export async function resumeStuckDefinedHandlesJob () {
    const inProgressVal = await redis.get(DEFINED_HANDLES_IN_PROGRESS_KEY);
    if (!inProgressVal) {
        return;
    }

    if (await redis.exists(DEFINED_HANDLES_QUEUE, DEFINED_HANDLES_DATA) === 0) {
        console.log("Defined Handles: No items in the queue or data to process.");
        return;
    }

    const inProgressTime = new Date(parseInt(inProgressVal, 10));
    if (inProgressTime < subMinutes(new Date(), 2)) {
        console.warn("Defined Handles: Resuming stuck job.");

        await scheduler.runJob<DefinedHandlesStatsJobData>({
            name: ControlSubredditJob.DefinedHandlesStatistics,
            runAt: addSeconds(new Date(), 5),
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
        });

        await expireKeyAt(DEFINED_HANDLES_QUEUE, addHours(new Date(), 2));
    }
}
