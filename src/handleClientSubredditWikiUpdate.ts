import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext, WikiPage } from "@devvit/public-api";
import { formatDate, subHours, subWeeks } from "date-fns";
import pako from "pako";
import pluralize from "pluralize";
import { max, toPairs } from "lodash";
import { CONTROL_SUBREDDIT, HANDLE_CLASSIFICATION_CHANGES_JOB } from "./constants.js";
import { BAN_STORE, USER_STORE, UserDetails, UserStatus, WIKI_PAGE } from "./dataStore.js";
import { setCleanupForUsers } from "./cleanup.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { isBanned, replaceAll } from "./utility.js";

const UNBAN_WHITELIST = "UnbanWhitelist";

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

                const recentUserContent = userContent.filter(item => item.createdAt > subWeeks(new Date(), 1));

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

                await Promise.all(recentUserContent.map(item => item.remove()));
            } catch {
                console.log(`Wiki Update: Couldn't retrieve content for ${username}`);
            }
        }
    }
}
