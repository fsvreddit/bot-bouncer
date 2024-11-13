import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, ScheduledJobEvent, JSONObject } from "@devvit/public-api";
import { setCleanupForUsers } from "./cleanup.js";
import { CONTROL_SUBREDDIT, HANDLE_UNBANS_JOB } from "./constants.js";
import { toPairs } from "lodash";
import { isBanned } from "./utility.js";
import pluralize from "pluralize";

const USER_STORE = "UserStore";
const BAN_STORE = "BanStore";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "BotBouncer";

export enum UserStatus {
    Pending = "pending",
    Banned = "banned",
    Service = "service",
    Organic = "organic",
    Purged = "purged",
    Retired = "retired",
}

interface UserDetails {
    trackingPostId: string;
    userStatus: UserStatus;
    lastUpdate: number;
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
    await context.redis.hSet(USER_STORE, { [username]: JSON.stringify(details) });
    await setCleanupForUsers([username], context);
    await queueWikiUpdate(context);
}

export async function deleteUserStatus (usernames: string[], context: TriggerContext) {
    await context.redis.hDel(USER_STORE, usernames);
    await queueWikiUpdate(context);
}

async function queueWikiUpdate (context: TriggerContext) {
    await context.redis.set(WIKI_UPDATE_DUE, "true");
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
    if (Object.entries(data).length === 0) {
        return;
    }

    const content = JSON.stringify(data);
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

export async function updateLocalStoreFromWiki (_: unknown, context: JobContext) {
    const lastUpdateKey = "lastUpdateFromWiki";
    const lastUpdateDateKey = "lastUpdateDateKey";

    const lastUpdateDateValue = await context.redis.get(lastUpdateDateKey);
    const lastUpdateDate = lastUpdateDateValue ? new Date(parseInt(lastUpdateDateValue)) : new Date();
    console.log(lastUpdateDate);

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        console.log("Wiki page does not exist on control subreddit");
        return;
    }

    const lastUpdate = await context.redis.get(lastUpdateKey);
    if (lastUpdate === wikiPage.revisionId) {
        console.log("Wiki Update: Wiki page has not changed.");
        return;
    }

    const incomingData = JSON.parse(wikiPage.content) as Record<string, string>;
    await context.redis.del(USER_STORE);

    if (Object.keys(incomingData).length === 0) {
        console.log("Wiki Update: Control subreddit wiki page is empty");
        return;
    }

    const usersAdded = await context.redis.hSet(USER_STORE, incomingData);

    console.log(`Wiki Update: Records for ${usersAdded} ${pluralize("user", usersAdded)} have been added`);

    const newUpdateDate = new Date();

    const unbannedUsers = toPairs(incomingData)
        .map(([username, userdata]) => ({ username, data: JSON.parse(userdata) as UserDetails }))
        .filter(item => new Date(item.data.lastUpdate) > lastUpdateDate && (item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Service))
        .map(item => item.username);

    await context.scheduler.runJob({
        name: HANDLE_UNBANS_JOB,
        runAt: new Date(),
        data: { unbannedUsers },
    });

    await context.redis.set(lastUpdateDateKey, newUpdateDate.getTime().toString());
    await context.redis.set(lastUpdateKey, wikiPage.revisionId);

    console.log("Wiki Update: Finished processing.");
}

export async function recordBan (username: string, context: TriggerContext) {
    await context.redis.zAdd(BAN_STORE, { member: username, score: new Date().getTime() });
    await setCleanupForUsers([username], context);
}

export async function removeRecordOfBan (usernames: string[], context: TriggerContext) {
    if (usernames.length > 0) {
        await context.redis.zRem(BAN_STORE, usernames);
    }
}

export async function wasUserBannedByApp (username: string, context: TriggerContext): Promise<boolean> {
    const score = await context.redis.zScore(BAN_STORE, username);
    return score !== undefined;
}

export async function handleUnbans (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const unbannedUsers = event.data?.unbannedUsers as string[] | undefined;
    if (!unbannedUsers || unbannedUsers.length === 0) {
        return;
    }

    console.log(`Wiki Update: Checking unbans for ${unbannedUsers.length} ${pluralize("user", unbannedUsers.length)}`);

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    for (const username of unbannedUsers) {
        const userBannedByApp = await wasUserBannedByApp(username, context);
        if (!userBannedByApp) {
            continue;
        }

        if (await isBanned(username, context)) {
            await context.reddit.unbanUser(username, subredditName);
            console.log(`Unbanned ${username} after wiki update`);
        }
    }
}
