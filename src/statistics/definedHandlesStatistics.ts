import { JobContext, JSONObject, Post, ScheduledJobEvent } from "@devvit/public-api";
import { BIO_TEXT_STORE, DISPLAY_NAME_STORE } from "../dataStore.js";
import { addSeconds, format, subMonths } from "date-fns";
import { getEvaluatorVariable } from "../userEvaluation/evaluatorVariables.js";
import { fromPairs } from "lodash";
import { ControlSubredditJob } from "../constants.js";
import json2md from "json2md";
import { StatsUserEntry } from "../sixHourlyJobs.js";
import { userIsBanned } from "./statsHelpers.js";
import { parse } from "regjsparser";

const DEFINED_HANDLES_QUEUE = "definedHandlesQueue";
const DEFINED_HANDLES_DATA = "definedHandlesData";
export const USER_DEFINED_HANDLES_POSTS = "userDefinedHandlesPosts";

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

export async function updateDefinedHandlesStats (allEntries: StatsUserEntry[], context: JobContext) {
    await context.redis.del(DEFINED_HANDLES_QUEUE);
    await context.redis.del(DEFINED_HANDLES_DATA);
    const lastMonthData = allEntries
        .filter(item => item.data.reportedAt && item.data.reportedAt > subMonths(new Date(), 3).getTime() && (userIsBanned(item.data)))
        .map(item => ({ member: item.username, score: item.data.reportedAt ?? 0 }));

    await context.redis.zAdd(DEFINED_HANDLES_QUEUE, ...lastMonthData);

    await context.scheduler.runJob({
        name: ControlSubredditJob.DefinedHandlesStatistics,
        runAt: addSeconds(new Date(), 1),
        data: { firstRun: true },
    });
}

export async function gatherDefinedHandlesStats (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const queuedHandles = await context.redis.zRange(DEFINED_HANDLES_QUEUE, 0, 9999);

    if (queuedHandles.length === 0) {
        console.log("No defined handles found in the queue.");
        await buildDefinedHandlesWikiPage(context);
        await context.redis.del(DEFINED_HANDLES_QUEUE);
        await context.redis.del(DEFINED_HANDLES_DATA);
        return;
    }

    const runLimit = addSeconds(new Date(), 15);
    let processedCount = 0;
    const processedUsers: string[] = [];

    const handles = await getDefinedHandles(context);

    if (handles.length === 0) {
        console.error("No defined handles found in evaluator variables.");
        return;
    }

    let existingDefinedHandles: Record<string, DefinedHandleData>;
    if (event.data?.firstRun) {
        existingDefinedHandles = {};
        for (const handle of handles) {
            existingDefinedHandles[handle] = { count: 0, lastSeen: 0, exampleUsers: [], foundInBio: false, foundInDisplayName: false, foundInPosts: false };
        }
    } else {
        const existingDefinedHandlesData = await context.redis.hGetAll(DEFINED_HANDLES_DATA);
        existingDefinedHandles = fromPairs(Object.entries(existingDefinedHandlesData).map(([handle, data]) => ([handle, JSON.parse(data) as DefinedHandleData])));
    }

    const userBioTextData = await context.redis.hMGet(BIO_TEXT_STORE, queuedHandles.map(handle => handle.member));
    const userDisplayNameData = await context.redis.hMGet(DISPLAY_NAME_STORE, queuedHandles.map(handle => handle.member));
    const userDefinedHandlesPosts = await context.redis.hMGet(USER_DEFINED_HANDLES_POSTS, queuedHandles.map(handle => handle.member));

    const bioTexts: Record<string, string> = {};
    const displayNames: Record<string, string> = {};
    const userDefinedHandlesPostsData: Record<string, UserDefinedHandlePost[]> = {};

    for (let i = 0; i < queuedHandles.length; i++) {
        const username = queuedHandles[i].member;
        const bioText = userBioTextData[i];
        const displayName = userDisplayNameData[i];
        const definedHandlesPosts = userDefinedHandlesPosts[i];

        if (definedHandlesPosts) {
            userDefinedHandlesPostsData[username] = JSON.parse(definedHandlesPosts) as UserDefinedHandlePost[];
        }

        if (bioText) {
            bioTexts[username] = bioText;
        }

        if (displayName) {
            displayNames[username] = displayName;
        }
    }

    while (queuedHandles.length > 0 && new Date() < runLimit) {
        const firstItem = queuedHandles.shift();
        if (!firstItem) {
            console.log("No more items in the queue to process.");
            break;
        }

        const username = firstItem.member;
        const userBioText = bioTexts[username] ?? "";
        const userDisplayName = displayNames[username] ?? "";
        const userDefinedHandles = userDefinedHandlesPostsData[username] ?? [];

        const handlesFound = handles.map((handle) => {
            const regex = new RegExp(`\\b${handle}\\b`, "u");
            return {
                handle,
                foundInBio: regex.test(userBioText),
                foundInDisplayName: regex.test(userDisplayName),
                foundInPosts: userDefinedHandles.some(post => regex.test(post.title)),
            };
        }).filter(handle => handle.foundInBio || handle.foundInDisplayName || handle.foundInPosts);

        for (const handleEntry of handlesFound) {
            const existingData = existingDefinedHandles[handleEntry.handle] ?? { count: 0, lastSeen: 0, exampleUsers: [], foundInBio: false, foundInDisplayName: false, foundInPosts: false };
            existingData.count++;
            existingData.lastSeen = Math.max(existingData.lastSeen, firstItem.score);
            existingData.exampleUsers.push(username);
            existingData.foundInBio ||= handleEntry.foundInBio;
            existingData.foundInDisplayName ||= handleEntry.foundInDisplayName;
            existingData.foundInPosts ||= handleEntry.foundInPosts;
            existingDefinedHandles[handleEntry.handle] = existingData;
        }

        processedCount++;
        processedUsers.push(username);
    }

    await context.redis.zRem(DEFINED_HANDLES_QUEUE, processedUsers);
    await context.redis.hSet(DEFINED_HANDLES_DATA, fromPairs(Object.entries(existingDefinedHandles).map(([handle, data]) => ([handle, JSON.stringify(data)]))));

    console.log(`Processed ${processedCount} defined handles. Remaining in queue: ${queuedHandles.length}.`);

    await context.scheduler.runJob({
        name: ControlSubredditJob.DefinedHandlesStatistics,
        runAt: addSeconds(new Date(), 1),
    });
}

function cleanHandleForSort (input: string): string {
    return input.replaceAll("\\b", "").replaceAll("[", "").replaceAll("(?:", "").replaceAll("(", "").toLowerCase();
}

async function buildDefinedHandlesWikiPage (context: JobContext) {
    const existingDefinedHandlesData = await context.redis.hGetAll(DEFINED_HANDLES_DATA);
    const existingDefinedHandles = Object.entries(existingDefinedHandlesData).map(([handle, data]) => ({ handle, data: JSON.parse(data) as DefinedHandleData }));

    existingDefinedHandles.sort((a, b) => (cleanHandleForSort(a.handle) < cleanHandleForSort(b.handle) ? -1 : 1));

    const wikiContent: json2md.DataObject[] = [
        { h1: "Defined Handles Statistics" },
        { p: "This page lists all defined handles and their usage statistics from the last three months." },
        { p: "This page only lists handles seen in user bios or display names, not in comments or posts, so is not comprehensive at this time." },
    ];

    const tableRows: string[][] = [];
    const tableHeaders = ["Handle", "Count", "Last Seen", "Found In", "Example Users"];

    for (const entry of existingDefinedHandles) {
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

    if (tableRows.length > 0) {
        wikiContent.push({ table: { headers: tableHeaders, rows: tableRows } });
    } else {
        wikiContent.push({ p: "No defined handles found in the last month." });
    }

    const suggestedHandles = existingDefinedHandles
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

    await context.reddit.updateWikiPage({
        subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        page: "statistics/definedhandles",
        content: json2md(wikiContent),
    });
}

async function getDefinedHandles (context: JobContext): Promise<string[]> {
    const definedHandles = await getEvaluatorVariable<string>("substitutions:definedhandles", context) ?? "";
    if (definedHandles.length === 0) {
        return [];
    }

    const parsedHandles = parse(definedHandles, "u");
    if (parsedHandles.type !== "disjunction") {
        return [];
    }

    return parsedHandles.body.map(node => node.raw);
}

async function storeDefinedHandlesData (username: string, context: JobContext) {
    let postHistory: Post[];
    try {
        postHistory = await context.reddit.getPostsByUser({
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

    const handles = await getDefinedHandles(context);
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
        await context.redis.hSet(USER_DEFINED_HANDLES_POSTS, { [username]: JSON.stringify(foundHandles) });
        console.log(`Defined Handles: Stored defined handles posts for user ${username}: Found ${foundHandles.map(post => post.handle).join(", ")}`);
    }
}

export async function storeDefinedHandlesDataJob (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const username = event.data?.username as string | undefined;
    if (!username) {
        console.error("No username provided in event data for storing defined handles data.");
        return;
    }

    await storeDefinedHandlesData(username, context);
}
