import { Comment, JobContext, JSONObject, Post, ScheduledJobEvent, SettingsValues, TriggerContext } from "@devvit/public-api";
import { addSeconds, formatDate, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { setCleanupForUsers } from "./cleanup.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { isBanned, replaceAll } from "./utility.js";
import { ClientSubredditJob } from "./constants.js";
import { fromPairs } from "lodash";
import { recordBanForDigest, removeRecordOfBanForDigest } from "./modmail/dailyDigest.js";

const UNBAN_WHITELIST = "UnbanWhitelist";
const BAN_STORE = "BanStore";

export async function recordBan (username: string, context: TriggerContext) {
    await context.redis.zAdd(BAN_STORE, { member: username, score: new Date().getTime() });
    await setCleanupForUsers([username], context, false);
    console.log(`Ban recorded for ${username}`);
}

export async function removeRecordOfBan (usernames: string[], context: TriggerContext) {
    if (usernames.length === 0) {
        return;
    }

    const actuallyRemoved = await context.redis.zRem(BAN_STORE, usernames);
    await Promise.all(usernames.map(username => removeRecordOfBanForDigest(username, context)));
    console.log(`Removed record of ban for ${actuallyRemoved}: ${usernames.join(", ")}`);
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

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus?.userStatus !== UserStatus.Banned) {
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

async function approveIfNotRemovedByMod (targetId: string, context: TriggerContext) {
    const removedByMod = await context.redis.exists(`removedbymod:${targetId}`);
    if (!removedByMod) {
        await context.reddit.approve(targetId);
    }
}

async function handleSetOrganic (username: string, subredditName: string, context: TriggerContext) {
    const contentToReinstate: string[] = [];

    const contentRemovedId = await context.redis.get(`removed:${username}`);
    if (contentRemovedId) {
        contentToReinstate.push(contentRemovedId);
    }

    const removedItems = await context.redis.hGetAll(`removedItems:${username}`);
    contentToReinstate.push(...Object.keys(removedItems));

    if (contentToReinstate.length > 0) {
        await Promise.all(contentToReinstate.map(id => approveIfNotRemovedByMod(id, context)));
        await context.redis.del(`removed:${username}`);
        await context.redis.del(`removedItems:${username}`);
        console.log(`Wiki Update: Reinstated ${contentToReinstate.length} ${pluralize("item", contentToReinstate.length)} for ${username}`);
    }

    const userBannedByApp = await wasUserBannedByApp(username, context);
    if (!userBannedByApp) {
        return;
    }

    if (await isBanned(username, context)) {
        await context.reddit.unbanUser(username, subredditName);
        console.log(`Wiki Update: Unbanned ${username}`);
    }

    await removeRecordOfBan([username], context);
}

async function handleSetBanned (username: string, subredditName: string, settings: SettingsValues, context: TriggerContext) {
    const isCurrentlyBanned = await isBanned(username, context);
    if (isCurrentlyBanned) {
        console.log(`Wiki Update: ${username} is already banned on ${subredditName}.`);
        return;
    }

    let userContent: (Comment | Post)[];
    try {
        userContent = await context.reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            timeframe: "week",
        }).all();
    } catch {
        return;
    }

    const recentLocalContent = userContent.filter(item => item.subredditName === subredditName && item.createdAt > subWeeks(new Date(), 1));

    if (recentLocalContent.length === 0) {
        return;
    }

    if (recentLocalContent.some(item => item.distinguishedBy)) {
        console.log(`Wiki Update: ${username} has distinguished content on ${subredditName}. Skipping.`);
        return;
    }

    const removableContent = recentLocalContent.filter(item => !item.spam && !item.removed);

    let message = settings[AppSetting.BanMessage] as string | undefined ?? CONFIGURATION_DEFAULTS.banMessage;
    message = replaceAll(message, "{subreddit}", subredditName);
    message = replaceAll(message, "{account}", username);
    message = replaceAll(message, "{link}", username);

    let banNote = CONFIGURATION_DEFAULTS.banNote;
    banNote = replaceAll(banNote, "{me}", context.appName);
    banNote = replaceAll(banNote, "{date}", formatDate(new Date(), "yyyy-MM-dd"));

    const results = await Promise.allSettled([
        context.reddit.banUser({
            subredditName,
            username,
            message,
            note: banNote,
        }),
        recordBan(username, context),
        recordBanForDigest(username, context),
        ...recentLocalContent.map(item => item.remove()),
    ]);

    const failedPromises = results.filter(result => result.status === "rejected");
    if (failedPromises.length > 0) {
        console.error(`Wiki Update: Some errors occurred banning ${username} on ${subredditName}.`);
        console.log(failedPromises);
    } else {
        console.log(`Wiki Update: ${username} has been banned following wiki update. ${removableContent.length} ${pluralize("item", removableContent.length)} removed.`);
    }

    if (removableContent.length > 0) {
        await context.redis.hSet(`removedItems:${username}`, fromPairs(removableContent.map(item => ([item.id, item.id]))));
        // Expire key after 14 days
        await context.redis.expire(`removedItems:${username}`, 60 * 60 * 24 * 14);
    }
}

export async function handleClassificationChanges (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const unbannedUsers = event.data?.unbannedUsers as string[] | undefined ?? [];
    const bannedUsers = event.data?.bannedUsers as string[] | undefined ?? [];

    if (unbannedUsers.length === 0 && bannedUsers.length === 0) {
        console.log("Wiki Update: No classification changes to process");
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const promises: Promise<unknown>[] = [];

    if (unbannedUsers.length > 0) {
        promises.push(...unbannedUsers.map(username => handleSetOrganic(username, subredditName, context)));
    }

    const settings = await context.settings.getAll();

    if (bannedUsers.length > 0 && settings[AppSetting.RemoveRecentContent] && !settings[AppSetting.HoneypotMode]) {
        // Take 5 users to process immediately, and schedule the rest
        const userCount = 5;
        const usersToProcess = bannedUsers.slice(0, userCount);
        promises.push(...usersToProcess.map(username => handleSetBanned(username, subredditName, settings, context)));

        const remainingUsers = bannedUsers.slice(userCount);
        if (remainingUsers.length > 0) {
            await context.scheduler.runJob({
                name: ClientSubredditJob.HandleClassificationChanges,
                runAt: addSeconds(new Date(), 5),
                data: { bannedUsers: remainingUsers, unbannedUsers: [] },
            });
        }
    }

    await Promise.all(promises);
}
