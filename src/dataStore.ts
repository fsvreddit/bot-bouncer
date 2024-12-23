import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage } from "@devvit/public-api";
import { compact, countBy, sum, toPairs } from "lodash";
import pako from "pako";
import { setCleanupForUsers } from "./cleanup.js";

export const USER_STORE = "UserStore";
const POST_STORE = "PostStore";
const AGGREGATE_STORE = "AggregateStore";
export const BAN_STORE = "BanStore";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
export const WIKI_PAGE = "botbouncer";

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
        if (currentStatus) {
            promises.push(updateAggregate(currentStatus.userStatus, -1, context));
        }
    }

    await Promise.all(promises);
}

export async function deleteUserStatus (usernames: string[], context: TriggerContext) {
    const currentStatuses = await Promise.all(usernames.map(username => getUserStatus(username, context)));

    const decrementsNeeded = toPairs(countBy(compact(currentStatuses.map(item => item?.userStatus))));

    const promises = [
        ...decrementsNeeded.map(([status, count]) => context.redis.zIncrBy(AGGREGATE_STORE, status, count)),
        context.redis.hDel(USER_STORE, usernames),
        queueWikiUpdate(context),
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
    await context.redis.zIncrBy(AGGREGATE_STORE, type, incrBy);
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
    await context.redis.set(WIKI_UPDATE_DUE, "true");
}

function compressData (value: Record<string, string>): string {
    return Buffer.from(pako.deflate(JSON.stringify(value), { level: 9 })).toString("base64");
}

export async function updateWikiPage (_: unknown, context: JobContext) {
    const updateDue = await context.redis.get(WIKI_UPDATE_DUE);
    if (!updateDue) {
        return;
    }

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, WIKI_PAGE);
    } catch {
        //
    }

    const data = await context.redis.hGetAll(USER_STORE);
    const entries = Object.entries(data);
    if (entries.length === 0) {
        return;
    }

    // Convert newer statuses to "Pending" to avoid data type issues.
    for (const entry of entries) {
        const [username, status] = entry;
        if (status as UserStatus === UserStatus.Declined || status as UserStatus === UserStatus.Inactive) {
            data[username] = UserStatus.Pending;
        }
    }

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

    console.log("Wiki page has been updated");
}
