import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, ScheduledJobEvent, JSONObject } from "@devvit/public-api";
import { compact, countBy, toPairs } from "lodash";
import pako from "pako";
import { isBanned, replaceAll } from "./utility.js";
import pluralize from "pluralize";
import { setCleanupForUsers } from "./cleanup.js";
import { CONTROL_SUBREDDIT, HANDLE_CLASSIFICATION_CHANGES_JOB } from "./constants.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { formatDate } from "date-fns";

const USER_STORE = "UserStore";
const POST_STORE = "PostStore";
const AGGREGATE_STORE = "AggregateStore";
const BAN_STORE = "BanStore";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "botbouncer";

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
    const currentStatus = await getUserStatus(username, context);

    const promises: Promise<unknown>[] = [
        context.redis.hSet(USER_STORE, { [username]: JSON.stringify(details) }),
        context.redis.hSet(POST_STORE, { [details.trackingPostId]: username }),
        setCleanupForUsers([username], context, true),
        queueWikiUpdate(context),
    ];

    if (details.userStatus !== currentStatus?.userStatus) {
        promises.push(context.redis.zIncrBy(AGGREGATE_STORE, details.userStatus, 1));
        if (currentStatus) {
            promises.push(context.redis.zIncrBy(AGGREGATE_STORE, currentStatus.userStatus, -1));
        }
    }

    await Promise.all(promises);
}

export async function deleteUserStatus (usernames: string[], context: TriggerContext) {
    const currentStatuses = await Promise.all(usernames.map(username => getUserStatus(username, context)));

    const decrementsNeeded = toPairs(countBy(compact(currentStatuses.map(item => item?.userStatus))));

    await Promise.all([
        ...decrementsNeeded.map(([status, count]) => context.redis.zIncrBy(AGGREGATE_STORE, status, count)),
        context.redis.hDel(USER_STORE, usernames),
        context.redis.hDel(POST_STORE, compact(currentStatuses.map(item => item?.trackingPostId))),
        queueWikiUpdate(context),
    ]);
}

export async function getUsernameFromPostId (postId: string, context: TriggerContext): Promise<string | undefined> {
    const username = await context.redis.hGet(POST_STORE, postId);
    return username;
}

export async function updateAggregate (type: UserStatus, incrBy: number, context: TriggerContext) {
    await context.redis.zIncrBy(AGGREGATE_STORE, type, incrBy);
}

async function queueWikiUpdate (context: TriggerContext) {
    await context.redis.set(WIKI_UPDATE_DUE, "true");
}

function compressData (value: Record<string, string>): string {
    return Buffer.from(pako.deflate(JSON.stringify(value))).toString("base64");
}

function decompressData (blob: string): Record<string, string> {
    let json: string;
    if (blob.startsWith("{")) {
        // Data is not compressed.
        json = blob;
    } else {
        json = Buffer.from(pako.inflate(Buffer.from(blob, "base64"))).toString();
    }
    return JSON.parse(json) as Record<string, string>;
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

export async function updateLocalStoreFromWiki (_: unknown, context: JobContext) {
    const lastUpdateKey = "lastUpdateFromWiki";
    const lastUpdateDateKey = "lastUpdateDateKey";

    const lastUpdateDateValue = await context.redis.get(lastUpdateDateKey);
    const lastUpdateDate = lastUpdateDateValue ? new Date(parseInt(lastUpdateDateValue)) : new Date();

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        console.log("Wiki page does not exist on control subreddit");
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

    const newUpdateDate = new Date();

    const usersWithStatus = toPairs(incomingData)
        .map(([username, userdata]) => ({ username, data: JSON.parse(userdata) as UserDetails }));

    const unbannedUsers = usersWithStatus
        .filter(item => new Date(item.data.lastUpdate) > lastUpdateDate && (item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Service))
        .map(item => item.username);

    const bannedUsers = usersWithStatus
        .filter(item => new Date(item.data.lastUpdate) > lastUpdateDate && item.data.userStatus === UserStatus.Banned)
        .map(item => item.username);

    if (bannedUsers.length > 0 || unbannedUsers.length > 0) {
        await context.scheduler.runJob({
            name: HANDLE_CLASSIFICATION_CHANGES_JOB,
            runAt: new Date(),
            data: { bannedUsers, unbannedUsers },
        });
        console.log(`Wiki Update: Users have been reclassified. Job scheduled to update local.`);
    }

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

export async function handleClassificationChanges (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const unbannedUsers = event.data?.unbannedUsers as string[] | undefined ?? [];
    const bannedUsers = event.data?.bannedUsers as string[] | undefined ?? [];

    if (unbannedUsers.length > 0) {
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

    const settings = await context.settings.getAll();

    if (bannedUsers.length > 0 && settings[AppSetting.RemoveRecentContent]) {
        for (const username of bannedUsers) {
            try {
                const userContent = await context.reddit.getCommentsAndPostsByUser({
                    username,
                    timeframe: "week",
                }).all();

                const localContent = userContent.filter(item => item.subredditName === context.subredditName);
                if (localContent.length === 0) {
                    console.log(`${username} has no recent content on subreddit to remove.`);
                    continue;
                }

                const isCurrentlyBanned = await isBanned(username, context);

                if (!isCurrentlyBanned) {
                    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
                    let message = settings[AppSetting.BanMessage] as string | undefined ?? CONFIGURATION_DEFAULTS.banMessage;
                    message = replaceAll(message, "{subreddit}", subredditName);
                    message = replaceAll(message, "{account}", username);
                    message = replaceAll(message, "{link}", username);

                    let banNote = CONFIGURATION_DEFAULTS.banNote;
                    banNote = replaceAll(banNote, "{me}", context.appName);
                    banNote = replaceAll(banNote, "{date}", formatDate(new Date(), "yyyy-MM-dd"));

                    await context.reddit.banUser({
                        subredditName,
                        username,
                        context: localContent[0].id,
                        message,
                        note: banNote,
                    });

                    await recordBan(username, context);

                    await Promise.all(localContent.map(item => item.remove()));
                } else {
                    console.log(`User ${username} is already banned from subreddit.`);
                }
            } catch {
                console.log(`Couldn't retrieve content for ${username}`);
            }
        }
    }
}
