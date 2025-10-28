import { Comment, JobContext, JSONObject, Post, RedisClient, ScheduledJobEvent, SettingsValues, TriggerContext } from "@devvit/public-api";
import { addSeconds, formatDate, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getRecentlyChangedUsers, getUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { setCleanupForUser } from "./cleanup.js";
import { ActionType, AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { getUserOrUndefined, isApproved, isBanned, isModerator, replaceAll } from "./utility.js";
import { ClientSubredditJob } from "./constants.js";
import { fromPairs } from "lodash";
import { recordBanForDigest, recordUnbanForDigest, removeRecordOfBanForDigest } from "./modmail/dailyDigest.js";

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
    await removeRecordOfBanForDigest(username, redis);
    await recordUnbanForDigest(username, redis);
    console.log(`Removed record of ban for ${username}`);
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
    const score = await context.redis.zScore(UNBAN_WHITELIST, username);
    return score !== undefined;
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

    const userBannedByApp = await wasUserBannedByApp(username, context);
    if (!userBannedByApp) {
        return;
    }

    if (await isBanned(username, context)) {
        await context.reddit.unbanUser(username, subredditName);
        console.log(`Classification Update: Unbanned ${username}`);
    }

    await removeRecordOfBan(username, context.redis);

    if (settings[AppSetting.AddModNoteOnClassificationChange]) {
        await context.reddit.addModNote({
            note: "User unbanned by Bot Bouncer after classification was changed",
            subreddit: subredditName,
            user: username,
        });
    }
}

async function handleSetBanned (username: string, subredditName: string, settings: SettingsValues, context: TriggerContext) {
    const isCurrentlyBanned = await isBanned(username, context);
    if (isCurrentlyBanned) {
        console.log(`Classification Update: ${username} is already banned on ${subredditName}.`);
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

    if (await isApproved(username, context)) {
        console.log(`Classification Update: ${username} is allowlisted as an approved user`);
        return;
    }

    if (await isModerator(username, context)) {
        console.log(`Classification Update: ${username} is allowlisted as a moderator`);
        return;
    }

    const removableContent = recentLocalContent.filter(item => !item.spam && !item.removed);

    const [actionToTake] = settings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];
    if (actionToTake === ActionType.Ban) {
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
            ...removableContent.map(item => item.remove()),
        ]);

        await recordBan(username, context.redis);
        await recordBanForDigest(username, context.redis);

        const reinstatableContent = removableContent.filter(item => item.userReportReasons.length === 0);
        if (reinstatableContent.length > 0) {
            await context.redis.hSet(`removedItems:${username}`, fromPairs(reinstatableContent.map(item => ([item.id, item.id]))));
            // Expire key after 14 days
            await context.redis.expire(`removedItems:${username}`, 60 * 60 * 24 * 14);
        }

        const failedPromises = results.filter(result => result.status === "rejected");
        if (failedPromises.length > 0) {
            console.error(`Classification Update: Some errors occurred banning ${username} on ${subredditName}.`);
            console.log(failedPromises);
        } else {
            console.log(`Classification Update: ${username} has been banned following classification update. ${removableContent.length} ${pluralize("item", removableContent.length)} removed.`);
        }

        if (settings[AppSetting.AddModNoteOnClassificationChange]) {
            await context.reddit.addModNote({
                note: "User banned by Bot Bouncer",
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
    const lastCheckDate = lastCheckData ? new Date(parseInt(lastCheckData, 10)) : subWeeks(now, 1);

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

function effectiveStatus (userDetails: UserDetails): "human" | "bot" | undefined {
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

    const settings = await context.settings.getAll();

    let processed = 0;

    while (items.length > 0 && new Date() < runLimit && processed < 50) {
        const item = items.shift();
        if (!item) {
            break;
        }

        const username = item.member;
        const currentStatus = await getUserStatus(username, context);

        if (!currentStatus) {
            console.log(`Classification Update: No user status found for ${username}. Skipping.`);
        } else {
            const status = effectiveStatus(currentStatus);
            if (status === "human") {
                await handleSetOrganic(username, subredditName, settings, context);
            } else if (status === "bot") {
                await handleSetBanned(username, subredditName, settings, context);
            }
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
