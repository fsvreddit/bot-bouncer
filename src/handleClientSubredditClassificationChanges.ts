import { Comment, JobContext, JSONObject, Post, RedisClient, ScheduledJobEvent, SettingsValues, TriggerContext } from "@devvit/public-api";
import { addDays, addSeconds, formatDate, subDays, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getRecentlyChangedUsers, getUserStatus, isUserInTempDeclineStore, UserDetails, UserStatus } from "./dataStore.js";
import { setCleanupForUser } from "./cleanup.js";
import { ActionType, AppSetting, CONFIGURATION_DEFAULTS, getControlSubSettings } from "./settings.js";
import { getPostOrCommentById, getUserOrUndefined, isModeratorWithCache, postIdToShortLink } from "./utility.js";
import { ClientSubredditJob } from "./constants.js";
import _ from "lodash";
import { recordBanForSummary, recordUnbanForSummary, removeRecordOfBanForSummary } from "./modmail/actionSummary.js";
import { expireKeyAt, hasPermissions, isBanned, isContributor } from "devvit-helpers";

const UNBAN_WHITELIST = "UnbanWhitelist";
const BAN_STORE = "BanStore";
const RECLASSIFICATION_QUEUE = "ReclassificationQueue";

export async function recordBan (username: string, redis: RedisClient) {
    await redis.zAdd(BAN_STORE, { member: username, score: new Date().getTime() });
    await setCleanupForUser(username, redis);
    console.log(`Ban recorded for ${username}`);
}

export async function removeRecordOfBan (username: string, redis: RedisClient) {
    await redis.zRem(BAN_STORE, [username]);
    await removeRecordOfBanForSummary(username, redis);
    console.log(`Removed record of ban for ${username}`);
}

export async function wasUserBannedByApp (username: string, context: TriggerContext): Promise<boolean> {
    return await context.redis.zScore(BAN_STORE, username).then(score => score !== undefined);
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

    const txn = await context.redis.watch();
    await txn.multi();
    await txn.zAdd(UNBAN_WHITELIST, { member: username, score: new Date().getTime() });
    await setCleanupForUser(username, txn);
    await txn.exec();
}

export async function removeWhitelistUnban (username: string, redis: RedisClient) {
    await redis.zRem(UNBAN_WHITELIST, [username]);
}

export async function isUserWhitelisted (username: string, context: TriggerContext) {
    return await context.redis.zScore(UNBAN_WHITELIST, username).then(score => score !== undefined);
}

async function approveIfNotRemovedByMod (targetId: string, context: TriggerContext) {
    const removedByMod = await context.redis.exists(`removedbymod:${targetId}`);
    if (!removedByMod) {
        try {
            await context.reddit.approve(targetId);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`Failed to approve ${targetId}:`, error.message);
            } else {
                console.error(`Failed to approve ${targetId}`);
            }
        }
    }
}

async function handleSetOrganic (username: string, subredditName: string, settings: SettingsValues, context: TriggerContext) {
    const contentToReinstate: string[] = [];

    const removedItems = await context.redis.hGetAll(`removedItems:${username}`);
    contentToReinstate.push(...Object.keys(removedItems));

    if (contentToReinstate.length > 0) {
        await Promise.all(contentToReinstate.map(id => approveIfNotRemovedByMod(id, context)));
        await context.redis.del(`removedItems:${username}`);
        console.log(`Classification Update: Reinstated ${contentToReinstate.length} ${pluralize("item", contentToReinstate.length)} for ${username}`);
    }

    const lockedItems = await context.redis.hGetAll(`lockedItems:${username}`);
    const lockedItemIds = Object.keys(lockedItems);
    if (lockedItemIds.length > 0) {
        await Promise.all(lockedItemIds.map(async (id) => {
            const item = await getPostOrCommentById(id, context);
            if (item.locked) {
                await item.unlock();
            }
        }));
        await context.redis.del(`lockedItems:${username}`);
        console.log(`Classification Update: Unlocked ${lockedItemIds.length} ${pluralize("item", lockedItemIds.length)} for ${username}`);
    }

    const userBannedByApp = await wasUserBannedByApp(username, context);
    if (!userBannedByApp) {
        return;
    }

    if (await isBanned(context.reddit, subredditName, username)) {
        await context.reddit.unbanUser(username, subredditName);
        console.log(`Classification Update: Unbanned ${username}`);
    }

    await removeRecordOfBan(username, context.redis);
    await recordUnbanForSummary(username, context.redis);

    if (settings[AppSetting.AddModNoteOnClassificationChange]) {
        let modNoteText = "User unbanned by Bot Bouncer after classification was changed";
        const currentStatus = await getUserStatus(username, context);
        if (currentStatus?.trackingPostId) {
            modNoteText += `. Tracking post: ${postIdToShortLink(currentStatus.trackingPostId)}`;
        }

        await context.reddit.addModNote({
            note: modNoteText,
            subreddit: subredditName,
            user: username,
        });
    }
}

async function handleSetBanned (username: string, subredditName: string, settings: SettingsValues, context: TriggerContext) {
    const isCurrentlyBanned = await isBanned(context.reddit, subredditName, username);
    if (isCurrentlyBanned) {
        console.log(`Classification Update: ${username} is already banned on ${subredditName}.`);
        return;
    }

    if (!await hasUserCreatedContentRecently(username, context)) {
        return;
    }

    let userContent: (Comment | Post)[];
    try {
        userContent = await context.reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            timeframe: "week",
            limit: 1000,
        }).all();
    } catch {
        return;
    }

    const userContextItems = await context.redis.hKeys(`userContextItems:${username}`);
    for (const itemId of userContextItems) {
        if (!userContent.some(item => item.id === itemId)) {
            console.log(`Classification Update: Adding context item ${itemId} for ${username}`);
            userContent.unshift(await getPostOrCommentById(itemId, context));
        }
    }

    const recentLocalContent = userContent.filter(item => item.subredditName === subredditName && item.createdAt > subWeeks(new Date(), 1));

    if (recentLocalContent.length === 0) {
        return;
    }

    if (recentLocalContent.some(item => item.distinguishedBy)) {
        console.log(`Classification Update: ${username} has distinguished content on ${subredditName}. Skipping.`);
        return;
    }

    const user = await getUserOrUndefined(username, context);
    if (user) {
        const flair = await user.getUserFlairBySubreddit(subredditName);
        if (flair?.flairCssClass?.toLowerCase().endsWith("proof")) {
            console.log(`Classification Update: ${user.username} is allowlisted via flair`);
            return;
        }
    }

    if (await isContributor(context.reddit, subredditName, username)) {
        console.log(`Classification Update: ${username} is allowlisted as an approved user`);
        return;
    }

    if (await isModeratorWithCache(username, context)) {
        console.log(`Classification Update: ${username} is allowlisted as a moderator`);
        return;
    }

    const removableContent = recentLocalContent.filter(item => !item.spam && !item.removed);

    const [actionToTake] = settings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];
    if (actionToTake === ActionType.Ban) {
        let message = settings[AppSetting.BanMessage] as string | undefined ?? CONFIGURATION_DEFAULTS.banMessage;
        message = message.replaceAll("{subreddit}", subredditName)
            .replaceAll("{account}", username);

        const banNote = CONFIGURATION_DEFAULTS.banNote
            .replaceAll("{me}", context.appSlug)
            .replaceAll("{date}", formatDate(new Date(), "yyyy-MM-dd"));

        const promises = [
            context.reddit.banUser({
                subredditName,
                username,
                message,
                note: banNote,
            }),
            ...removableContent.map(item => item.remove()),
        ];

        if (settings[AppSetting.LockContentWhenRemoving]) {
            promises.push(...removableContent.filter(item => !item.locked).map(item => item.lock()));
        }

        const results = await Promise.allSettled(promises);

        await recordBan(username, context.redis);
        await recordBanForSummary(username, context.redis);

        const reinstatableContent = removableContent.filter(item => item.userReportReasons.length === 0);
        if (reinstatableContent.length > 0) {
            await context.redis.hSet(`removedItems:${username}`, _.fromPairs(reinstatableContent.map(item => ([item.id, item.id]))));
            // Expire key after 14 days
            await expireKeyAt(context.redis, `removedItems:${username}`, addDays(new Date(), 14));

            if (settings[AppSetting.LockContentWhenRemoving]) {
                await context.redis.hSet(`lockedItems:${username}`, _.fromPairs(reinstatableContent.map(item => ([item.id, item.id]))));
                await expireKeyAt(context.redis, `lockedItems:${username}`, addDays(new Date(), 14));
            }
        }

        const failedPromises = results.filter(result => result.status === "rejected");
        if (failedPromises.length > 0) {
            console.error(`Classification Update: Some errors occurred banning ${username} on ${subredditName}.`);
            console.log(failedPromises);
        } else {
            console.log(`Classification Update: ${username} has been banned following classification update. ${removableContent.length} ${pluralize("item", removableContent.length)} removed.`);
        }

        if (settings[AppSetting.AddModNoteOnClassificationChange]) {
            let modNoteText = "User banned by Bot Bouncer";
            const currentStatus = await getUserStatus(username, context);
            if (currentStatus?.trackingPostId) {
                modNoteText += `. Tracking post: ${postIdToShortLink(currentStatus.trackingPostId)}`;
            }

            await context.reddit.addModNote({
                note: modNoteText,
                subreddit: subredditName,
                user: username,
                label: "BOT_BAN",
            });
        }
    } else {
        // Report content instead of banning.
        await Promise.all(removableContent.map(async (item) => {
            const itemReported = await context.redis.get(`reported:${item.id}`);
            if (!itemReported) {
                await context.reddit.report(item, { reason: "User is listed as a bot on r/BotBouncer" });
            }
        }));
    }
}

export async function queueRecentReclassifications (_: unknown, context: JobContext) {
    const now = new Date();
    const lastCheckKey = "lastUpdateDateKey";
    const lastCheckData = await context.redis.get(lastCheckKey);
    const lastCheckDate = lastCheckData ? new Date(parseInt(lastCheckData, 10)) : subDays(now, 1);

    const recentlyChangedUsers = await getRecentlyChangedUsers(lastCheckDate, now, context);
    if (recentlyChangedUsers.length > 0) {
        await context.redis.zAdd(RECLASSIFICATION_QUEUE, ...recentlyChangedUsers);
        console.log(`Classification Update: Queued ${recentlyChangedUsers.length} ${pluralize("user", recentlyChangedUsers.length)} for reclassification.`);
    }

    await context.redis.set(lastCheckKey, now.getTime().toString());

    await context.scheduler.runJob({
        name: ClientSubredditJob.HandleClassificationChanges,
        runAt: addSeconds(new Date(), 1),
        data: { firstRun: true },
    });
}

function effectiveStatus (userDetails?: UserDetails): "human" | "bot" | undefined {
    if (!userDetails) {
        return;
    }

    if (userDetails.userStatus === UserStatus.Pending) {
        return;
    }

    if (userDetails.userStatus === UserStatus.Organic || userDetails.userStatus === UserStatus.Declined || userDetails.userStatus === UserStatus.Service || userDetails.userStatus === UserStatus.Inactive) {
        return "human";
    }

    if (userDetails.userStatus === UserStatus.Banned) {
        return "bot";
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (userDetails.userStatus === UserStatus.Purged || userDetails.userStatus === UserStatus.Retired) {
        if (userDetails.lastStatus === undefined) {
            return "bot";
        }

        if (userDetails.lastStatus === UserStatus.Purged || userDetails.lastStatus === UserStatus.Retired) {
            return;
        }

        return effectiveStatus({ ...userDetails, userStatus: userDetails.lastStatus, lastStatus: undefined });
    }
}

export async function handleClassificationChanges (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const recentlyRunKey = "classificationChangesLastRun";
    if (event.data?.firstRun && await context.redis.exists(recentlyRunKey)) {
        console.log("Classification Update: Classification changes job ran recently, skipping this run.");
        return;
    }

    await context.redis.set(recentlyRunKey, "true", { expiration: addSeconds(new Date(), 30) });

    const runLimit = addSeconds(new Date(), 15);
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const items = await context.redis.zRange(RECLASSIFICATION_QUEUE, 0, Date.now(), { by: "score" });
    if (items.length === 0) {
        return;
    } else if (!event.data?.firstRun) {
        console.log(`Classification Update: Processing ${items.length} ${pluralize("user", items.length)} in reclassification queue for ${subredditName}.`);
    }

    if (!await appAccountHasPermissions(context)) {
        console.warn(`Classification Update: Bot Bouncer does not have sufficient permissions on r/${subredditName} to process classification changes.`);
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.clientReclassificationDisabled) {
        console.log(`Classification Update: Client subreddit reclassification is disabled.`);
        return;
    }

    const settings = await context.settings.getAll();

    let processed = 0;

    while (items.length > 0 && new Date() < runLimit && processed < 50) {
        const item = items.shift();
        if (!item) {
            break;
        }

        const username = item.member;
        const currentStatus = await getUserStatus(username, context);

        const status = effectiveStatus(currentStatus);
        if (status === "human") {
            await handleSetOrganic(username, subredditName, settings, context);
        } else if (status === "bot") {
            await handleSetBanned(username, subredditName, settings, context);
        } else if (await isUserInTempDeclineStore(username, context)) {
            await handleSetOrganic(username, subredditName, settings, context);
        }

        await context.redis.zRem(RECLASSIFICATION_QUEUE, [username]);
        processed++;
    }

    if (items.length > 0) {
        await context.scheduler.runJob({
            name: ClientSubredditJob.HandleClassificationChanges,
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        console.log("Classification Update: All users in reclassification queue processed.");
        await context.redis.del(recentlyRunKey);
    }
}

const APP_PERMISSIONS_CACHE_KEY = "AppPermissionsCache";

async function appAccountHasPermissions (context: TriggerContext): Promise<boolean> {
    const cachedResult = await context.redis.get(APP_PERMISSIONS_CACHE_KEY);
    if (cachedResult !== undefined) {
        return JSON.parse(cachedResult) as boolean;
    }

    const hasPerms = await hasPermissions(context.reddit, {
        subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        username: context.appSlug,
        requiredPerms: ["access", "posts"],
    });

    await context.redis.set(APP_PERMISSIONS_CACHE_KEY, JSON.stringify(hasPerms), { expiration: addDays(new Date(), 1) });
    return hasPerms;
}

export async function clearAppPermissionsCache (context: TriggerContext) {
    await context.redis.del(APP_PERMISSIONS_CACHE_KEY);
}

function getUserContentCreationKey (username: string): string {
    return `userCreatedContentRecently:${username}`;
}

const IN_GRACE_PERIOD_KEY = "InContentCreationGracePeriod";

export async function recordUserContentCreation (username: string, context: TriggerContext) {
    await context.redis.set(getUserContentCreationKey(username), "", { expiration: addDays(new Date(), 7) });
}

async function hasUserCreatedContentRecently (username: string, context: TriggerContext): Promise<boolean> {
    return context.redis.exists(getUserContentCreationKey(username), IN_GRACE_PERIOD_KEY).then(exists => exists !== 0);
}

export async function storeRecordOfContentCreationGracePeriod (context: TriggerContext) {
    const gracePeriodStoredKey = "ContentCreationGracePeriodStored";
    if (await context.redis.exists(gracePeriodStoredKey)) {
        return;
    }

    await context.redis.set(IN_GRACE_PERIOD_KEY, "true", { expiration: addDays(new Date(), 7) });
    await context.redis.set(gracePeriodStoredKey, "true");
}
