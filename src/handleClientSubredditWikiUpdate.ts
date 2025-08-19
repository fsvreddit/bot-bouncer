import { Comment, JobContext, Post, RedisClient, SettingsValues, TriggerContext } from "@devvit/public-api";
import { addMinutes, addSeconds, formatDate, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { setCleanupForUser } from "./cleanup.js";
import { ActionType, AppSetting, CONFIGURATION_DEFAULTS } from "./settings.js";
import { isBanned, replaceAll } from "./utility.js";
import { CLIENT_SUB_WIKI_UPDATE_CRON_KEY, ClientSubredditJob } from "./constants.js";
import { fromPairs } from "lodash";
import { recordBanForDigest, recordUnbanForDigest, removeRecordOfBanForDigest } from "./modmail/dailyDigest.js";
import { ZMember } from "@devvit/protos";
import { CronExpressionParser } from "cron-parser";

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
        await context.reddit.approve(targetId);
    }
}

async function handleSetOrganic (username: string, subredditName: string, context: TriggerContext) {
    const contentToReinstate: string[] = [];

    const removedItems = await context.redis.hGetAll(`removedItems:${username}`);
    contentToReinstate.push(...Object.keys(removedItems));

    if (contentToReinstate.length > 0) {
        await Promise.all(contentToReinstate.map(id => approveIfNotRemovedByMod(id, context)));
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

    await removeRecordOfBan(username, context.redis);
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
        console.log(`Wiki Update: ${username} has distinguished content on ${subredditName}. Skipping.`);
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
            console.error(`Wiki Update: Some errors occurred banning ${username} on ${subredditName}.`);
            console.log(failedPromises);
        } else {
            console.log(`Wiki Update: ${username} has been banned following wiki update. ${removableContent.length} ${pluralize("item", removableContent.length)} removed.`);
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

export async function queueReclassifications (items: ZMember[], context: TriggerContext) {
    if (items.length === 0) {
        return;
    }

    await context.redis.zAdd(RECLASSIFICATION_QUEUE, ...items);
}

export async function handleClassificationChanges (_: unknown, context: JobContext) {
    const clientSubReclassificationCron = await context.redis.get(CLIENT_SUB_WIKI_UPDATE_CRON_KEY);
    if (clientSubReclassificationCron) {
        const nextScheduledRun = CronExpressionParser.parse(clientSubReclassificationCron).next().toDate();
        if (nextScheduledRun < addMinutes(new Date(), 1)) {
            console.log("Wiki Update: Client subreddit reclassification job is already scheduled to run soon. Skipping.");
            return;
        }
    } else {
        console.error("Wiki Update: Client subreddit reclassification cron not found. This job should not be run directly.");
    }

    const runLimit = addSeconds(new Date(), 15);
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const items = await context.redis.zRange(RECLASSIFICATION_QUEUE, 0, -1);
    if (items.length === 0) {
        console.log("Wiki Update: No users to process in reclassification queue.");
        return;
    } else {
        console.log(`Wiki Update: Processing ${items.length} ${pluralize("user", items.length)} in reclassification queue for ${subredditName}.`);
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
            console.log(`Wiki Update: No user status found for ${username}. Skipping.`);
        } else if (currentStatus.userStatus === UserStatus.Organic || currentStatus.userStatus === UserStatus.Declined || currentStatus.userStatus === UserStatus.Service) {
            await handleSetOrganic(username, subredditName, context);
        } else if (currentStatus.userStatus === UserStatus.Banned) {
            await handleSetBanned(username, subredditName, settings, context);
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
        console.log("Wiki Update: All users in reclassification queue processed.");
    }
}
