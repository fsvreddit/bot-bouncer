import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, ScheduledJobEvent, JSONObject } from "@devvit/public-api";
import { compact, max, sum, toPairs } from "lodash";
import pako from "pako";
import { scheduleAdhocCleanup, setCleanupForUsers } from "./cleanup.js";
import { CONTROL_SUBREDDIT, HANDLE_CLASSIFICATION_CHANGES_JOB } from "./constants.js";
import { addWeeks, subDays, subHours, subWeeks } from "date-fns";
import pluralize from "pluralize";

const USER_STORE = "UserStore";
const POST_STORE = "PostStore";
const AGGREGATE_STORE = "AggregateStore";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "botbouncer";
const MAX_WIKI_PAGE_SIZE = 524288;

export enum UserStatus {
    Pending = "pending",
    Banned = "banned",
    Service = "service",
    Organic = "organic",
    Purged = "purged",
    Retired = "retired",
    Declined = "declined",
    Inactive = "inactive",
}

export interface UserDetails {
    trackingPostId: string;
    userStatus: UserStatus;
    lastUpdate: number;
    submitter?: string;
    operator: string;
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.hGet(USER_STORE, username);
    if (!value) {
        return;
    }

    return JSON.parse(value) as UserDetails;
}

export async function setUserStatus (username: string, details: UserDetails, context: TriggerContext) {
    const currentStatus = await getUserStatus(username, context);

    const promises: Promise<unknown>[] = [
        context.redis.hSet(USER_STORE, { [username]: JSON.stringify(details) }),
        context.redis.hSet(POST_STORE, { [details.trackingPostId]: username }),
        setCleanupForUsers([username], context, true, 1),
        queueWikiUpdate(context),
    ];

    if (details.userStatus !== currentStatus?.userStatus) {
        promises.push(updateAggregate(details.userStatus, 1, context));
        console.log(`Aggregate for ${details.userStatus} incremented`);
        if (currentStatus) {
            promises.push(updateAggregate(currentStatus.userStatus, -1, context));
            console.log(`Aggregate for ${currentStatus.userStatus} decremented`);
        }
    }

    await Promise.all(promises);
    await scheduleAdhocCleanup(context);
}

export async function deleteUserStatus (usernames: string[], context: TriggerContext) {
    const currentStatuses = await Promise.all(usernames.map(username => getUserStatus(username, context)));

    const promises = [
        context.redis.hDel(USER_STORE, usernames),
    ];

    const postsToDeleteTrackingFor = compact(currentStatuses.map(item => item?.trackingPostId));
    if (postsToDeleteTrackingFor.length > 0) {
        promises.push(context.redis.hDel(POST_STORE, postsToDeleteTrackingFor));
    }

    await Promise.all(promises);
}

export async function getUsernameFromPostId (postId: string, context: TriggerContext): Promise<string | undefined> {
    const username = await context.redis.hGet(POST_STORE, postId);
    return username;
}

export async function updateAggregate (type: UserStatus, incrBy: number, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await context.redis.zIncrBy(AGGREGATE_STORE, type, incrBy);
    }
}

export async function writeAggregateToWikiPage (_: unknown, context: JobContext) {
    let results = await context.redis.zRange(AGGREGATE_STORE, 0, -1);
    results = results.filter(item => item.member !== "pending");

    let wikiContent = "# Bot Bouncer statistics\n\nThis page details the number of accounts that have been processed by Bot Bouncer.\n\n";

    for (const item of results) {
        wikiContent += `* **${item.member}**: ${item.score.toLocaleString()}\n`;
    }

    wikiContent += `\n**Total accounts processed**: ${sum(results.map(item => item.score)).toLocaleString()}\n\n`;
    wikiContent += "These statistics update once a day at midnight UTC.";

    const wikiPageName = "statistics";
    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, wikiPageName);
    } catch {
        //
    }

    const wikiPageSaveOptions = {
        subredditName,
        page: wikiPageName,
        content: wikiContent,
    };

    if (wikiPage) {
        if (wikiContent.trim() !== wikiPage.content.trim()) {
            await context.reddit.updateWikiPage(wikiPageSaveOptions);
        }
    } else {
        await context.reddit.createWikiPage(wikiPageSaveOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName,
            page: wikiPageName,
            listed: true,
            permLevel: WikiPagePermissionLevel.SUBREDDIT_PERMISSIONS,
        });
    }
}

async function queueWikiUpdate (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    await context.redis.set(WIKI_UPDATE_DUE, "true");
}

function compressData (value: Record<string, string>): string {
    return Buffer.from(pako.deflate(JSON.stringify(value), { level: 9 })).toString("base64");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function compactDataForWiki (input: string): string {
    const status = JSON.parse(input) as UserDetails;
    status.operator = "";
    delete status.submitter;
    if (status.lastUpdate < subWeeks(new Date(), 1).getTime()) {
        status.lastUpdate = 0;
    }
    return JSON.stringify(status);
}

export async function updateWikiPage (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const forceUpdate = event.data?.force as boolean | undefined ?? false;
    const updateDue = await context.redis.get(WIKI_UPDATE_DUE);
    if (!updateDue && !forceUpdate) {
        return;
    }

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, WIKI_PAGE);
    } catch {
        //
    }

    if (wikiPage?.revisionDate && wikiPage.revisionDate > subDays(new Date(), 1) && forceUpdate) {
        // No need to run the monthly forced update, the page has been updated recently.
        return;
    }

    const data = await context.redis.hGetAll(USER_STORE);
    const entries = Object.entries(data);
    if (entries.length === 0) {
        return;
    }

    // Data compaction - TODO
    // for (const entry of entries) {
    //     const [username, jsonData] = entry;
    //     data[username] = compactDataForWiki(jsonData)
    // }

    const content = compressData(data);
    if (content === wikiPage?.content) {
        return;
    }

    const wikiUpdateOptions = {
        subredditName,
        content,
        page: WIKI_PAGE,
    };

    if (wikiPage) {
        await context.reddit.updateWikiPage(wikiUpdateOptions);
    } else {
        await context.reddit.createWikiPage(wikiUpdateOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName,
            listed: true,
            page: WIKI_PAGE,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }

    await context.redis.del(WIKI_UPDATE_DUE);

    console.log(`Wiki page has been updated with ${entries.length} entries`);

    if (content.length > MAX_WIKI_PAGE_SIZE * 0.5) {
        const spaceAlertKey = "wikiSpaceAlert";
        const alertDone = await context.redis.get(spaceAlertKey);
        if (!alertDone) {
            const message = `The botbouncer wiki page is now at ${Math.round(content.length / MAX_WIKI_PAGE_SIZE * 100)}% of its maximum size. It's time to rethink how data is stored.\n\nI will modmail you again in a week.`;
            await context.reddit.modMail.createModInboxConversation({
                subject: "r/BotBouncer wiki page size alert",
                bodyMarkdown: message,
                subredditId: context.subredditId,
            });
            await context.redis.set(spaceAlertKey, new Date().getTime().toString(), { expiration: addWeeks(new Date(), 1) });
        }
    }
}

function decompressData (blob: string): Record<string, string> {
    const json = Buffer.from(pako.inflate(Buffer.from(blob, "base64"))).toString();
    return JSON.parse(json) as Record<string, string>;
}

export async function updateLocalStoreFromWiki (_: unknown, context: JobContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const lastUpdateKey = "lastUpdateFromWiki";
    const lastUpdateDateKey = "lastUpdateDateKey";

    const lastUpdateDateValue = await context.redis.get(lastUpdateDateKey);
    const lastUpdateDate = lastUpdateDateValue ? new Date(parseInt(lastUpdateDateValue)) : subHours(new Date(), 6);

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch (error) {
        console.error("Wiki Update: Failed to read wiki page from control subreddit");
        console.log(error);
        return;
    }

    const lastUpdate = await context.redis.get(lastUpdateKey);
    if (lastUpdate === wikiPage.revisionId) {
        return;
    }

    const incomingData = decompressData(wikiPage.content);
    await context.redis.del(USER_STORE);

    if (Object.keys(incomingData).length === 0) {
        console.log("Wiki Update: Control subreddit wiki page is empty");
        return;
    }

    const usersAdded = await context.redis.hSet(USER_STORE, incomingData);

    console.log(`Wiki Update: Records for ${usersAdded} ${pluralize("user", usersAdded)} have been added`);

    const usersWithStatus = toPairs(incomingData)
        .map(([username, userdata]) => ({ username, data: JSON.parse(userdata) as UserDetails }))
        .filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

    if (usersWithStatus.length > 0) {
        const newUpdateDate = max(usersWithStatus.map(item => item.data.lastUpdate)) ?? new Date().getTime();

        const recentItems = usersWithStatus.filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

        const unbannedUsers = recentItems
            .filter(item => item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Service)
            .map(item => item.username);

        const bannedUsers = recentItems
            .filter(item => item.data.userStatus === UserStatus.Banned)
            .map(item => item.username);

        if (bannedUsers.length > 0 || unbannedUsers.length > 0) {
            await context.scheduler.runJob({
                name: HANDLE_CLASSIFICATION_CHANGES_JOB,
                runAt: new Date(),
                data: { bannedUsers, unbannedUsers },
            });
            const count = bannedUsers.length + unbannedUsers.length;
            console.log(`Wiki Update: ${count} ${pluralize("user", count)} ${pluralize("has", count)} been reclassified. Job scheduled to update local store.`);
        }

        await context.redis.set(lastUpdateDateKey, newUpdateDate.toString());
    } else {
        console.log("Wiki Update: Finished processing.");
    }

    await context.redis.set(lastUpdateKey, wikiPage.revisionId);
}
