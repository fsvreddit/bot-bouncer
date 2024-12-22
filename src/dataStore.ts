import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, ScheduledJobEvent, JSONObject } from "@devvit/public-api";
import { compact, countBy, max, sum, toPairs } from "lodash";
import pako from "pako";
import { isBanned, replaceAll } from "./utility.js";
import pluralize from "pluralize";
import { setCleanupForUsers } from "./cleanup.js";
import { CONTROL_SUBREDDIT, HANDLE_CLASSIFICATION_CHANGES_JOB } from "./constants.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { formatDate, subHours } from "date-fns";

const USER_STORE = "UserStore";
const POST_STORE = "PostStore";
const AGGREGATE_STORE = "AggregateStore";
const BAN_STORE = "BanStore";
const UNBAN_WHITELIST = "UnbanWhitelist";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "botbouncer";

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

interface UserDetails {
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

export async function updateLocalStoreFromWiki (_: unknown, context: JobContext) {
    const lastUpdateKey = "lastUpdateFromWiki";
    const lastUpdateDateKey = "lastUpdateDateKey";

    const lastUpdateDateValue = await context.redis.get(lastUpdateDateKey);
    const lastUpdateDate = lastUpdateDateValue ? new Date(parseInt(lastUpdateDateValue)) : subHours(new Date(), 6);

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

    const usersWithStatus = toPairs(incomingData)
        .map(([username, userdata]) => ({ username, data: JSON.parse(userdata) as UserDetails }))
        .filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

    if (usersWithStatus.length > 0) {
        const newUpdateDate = max(usersWithStatus.map(item => item.data.lastUpdate)) ?? new Date().getTime();

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
            const count = bannedUsers.length + unbannedUsers.length;
            console.log(`Wiki Update: ${count} ${pluralize("user", count)} ${pluralize("has", count)} been reclassified. Job scheduled to update local store.`);
        }

        await context.redis.set(lastUpdateDateKey, newUpdateDate.toString());
    }

    await context.redis.set(lastUpdateKey, wikiPage.revisionId);

    console.log("Wiki Update: Finished processing.");
}

export async function recordBan (username: string, context: TriggerContext) {
    await context.redis.zAdd(BAN_STORE, { member: username, score: new Date().getTime() });
    await setCleanupForUsers([username], context, false, 1);
}

export async function removeRecordOfBan (usernames: string[], context: TriggerContext) {
    if (usernames.length === 0) {
        return;
    }

    await context.redis.zRem(BAN_STORE, usernames);
}

export async function wasUserBannedByApp (username: string, context: TriggerContext): Promise<boolean> {
    const score = await context.redis.zScore(BAN_STORE, username);
    return score !== undefined;
}

export async function recordWhitelistUnban (username: string, context: TriggerContext) {
    const whitelistEnabled = await context.settings.get<boolean>(AppSetting.AutoWhitelist);
    if (!whitelistEnabled) {
        return;
    }
    await context.redis.zAdd(UNBAN_WHITELIST, { member: username, score: new Date().getTime() });
    await setCleanupForUsers([username], context);
}

export async function removeWhitelistUnban (usernames: string[], context: TriggerContext) {
    await context.redis.zRem(UNBAN_WHITELIST, usernames);
}

export async function isUserWhitelisted (username: string, context: TriggerContext) {
    const score = await context.redis.zScore(UNBAN_WHITELIST, username);
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
                console.log(`Wiki Update: ${username} was not banned by this app.`);
                continue;
            }

            if (await isBanned(username, context)) {
                await context.reddit.unbanUser(username, subredditName);
                console.log(`Wiki Update: Unbanned ${username}`);
            }
        }

        await removeRecordOfBan(unbannedUsers, context);
    }

    const settings = await context.settings.getAll();

    if (bannedUsers.length > 0 && settings[AppSetting.RemoveRecentContent]) {
        for (const username of bannedUsers) {
            try {
                const isCurrentlyBanned = await isBanned(username, context);
                if (isCurrentlyBanned) {
                    console.log(`Wiki Update: ${username} is already banned.`);
                    continue;
                }

                const userContent = await context.reddit.getCommentsAndPostsByUser({
                    username,
                    timeframe: "week",
                }).all();

                const localContent = userContent.filter(item => item.subredditName === context.subredditName);
                if (localContent.length === 0) {
                    console.log(`Wiki Update: ${username} has no recent content on subreddit to remove.`);
                    continue;
                }

                if (localContent.some(item => item.distinguishedBy)) {
                    console.log(`Wiki Update: ${username} has distinguished content on subreddit. Skipping.`);
                    continue;
                }

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

                console.log(`Wiki Update: ${username} has been banned following wiki update.`);

                await Promise.all(localContent.map(item => item.remove()));
            } catch {
                console.log(`Wiki Update: Couldn't retrieve content for ${username}`);
            }
        }
    }
}
