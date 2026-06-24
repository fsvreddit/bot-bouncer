import { JobContext, RedisClient, TxClientLike, ZMember } from "@devvit/public-api";
import { addDays, format, getDay, subDays } from "date-fns";
import { getUserStatus } from "../dataStore.js";
import { AppSetting, DigestFrequency } from "../settings.js";
import json2md from "json2md";
import { expireKeyAt } from "devvit-helpers";
import { getNewVersionInfo } from "../upgradeNotifier.js";
import pluralize from "pluralize";

const CUMULATIVE_BANS_KEY = "digest:cumulative:bans";
const CUMULATIVE_UNBANS_KEY = "digest:cumulative:unbans";
const CUMULATIVE_STATS_START_KEY = "digest:cumulative:start";
const CUMULATIVE_STATS_START_REASON_KEY = "digest:cumulative:startReason";

function getReportsKey (date: Date) {
    return `digest:reports:${format(date, `yyyy-MM-dd`)}`;
}

function getBansKey (date: Date) {
    return `digest:bans:${format(date, `yyyy-MM-dd`)}`;
}

function getUnbansKey (date: Date) {
    return `digest:unbans:${format(date, `yyyy-MM-dd`)}`;
}

interface DigestSummaryCounts {
    reported: number | undefined;
    banned: number | undefined;
    unbanned: number | undefined;
}

interface DigestSummaryOptions {
    fullAccountListIncluded: boolean;
}

type CumulativeDigestStats = {
    banCount: number;
    unbanCount: number;
    startDate?: Date;
    startReason?: "install" | "upgrade" | "tracking";
};

async function getCounterValue (redis: RedisClient, key: string): Promise<number> {
    const value = await redis.get(key);
    if (!value) {
        return 0;
    }

    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
        return 0;
    }

    return parsedValue;
}

function isCumulativeStatsStartReason (startReason?: string): startReason is "install" | "upgrade" | "tracking" {
    return startReason === "install" || startReason === "upgrade" || startReason === "tracking";
}

async function getCumulativeDigestStats (redis: RedisClient): Promise<CumulativeDigestStats> {
    const [banCount, unbanCount, startDateString, startReason] = await Promise.all([
        getCounterValue(redis, CUMULATIVE_BANS_KEY),
        getCounterValue(redis, CUMULATIVE_UNBANS_KEY),
        redis.get(CUMULATIVE_STATS_START_KEY),
        redis.get(CUMULATIVE_STATS_START_REASON_KEY),
    ]);

    const startDateNumber = startDateString ? parseInt(startDateString, 10) : undefined;
    const startDate = startDateNumber && !isNaN(startDateNumber) ? new Date(startDateNumber) : undefined;

    return {
        banCount,
        unbanCount,
        startDate,
        startReason: isCumulativeStatsStartReason(startReason) ? startReason : undefined,
    };
}

export async function ensureDigestCumulativeStatsStart (redis: RedisClient, startReason: "install" | "upgrade" | "tracking") {
    if (await redis.exists(CUMULATIVE_STATS_START_KEY)) {
        return;
    }

    await redis.set(CUMULATIVE_STATS_START_KEY, Date.now().toString());
    await redis.set(CUMULATIVE_STATS_START_REASON_KEY, startReason);
}

function pluralizedUserCount (count: number) {
    return `${count} ${pluralize("user", count)}`;
}

function countVerb (count: number) {
    return count === 1 ? "was" : "were";
}

export function buildCountOnlyActionSummary (action: "banned" | "unbanned", count: number, subredditName: string, intervalText: string) {
    const userCount = pluralizedUserCount(count);
    return `${userCount} ${countVerb(count)} ${action} by Bot Bouncer on /r/${subredditName} ${intervalText}.`;
}

export function buildCumulativeStatsSummary (stats: CumulativeDigestStats, includeBans: boolean, includeUnbans: boolean) {
    const parts: string[] = [];
    if (includeBans) {
        parts.push(`${stats.banCount} ${pluralize("ban", stats.banCount)}`);
    }
    if (includeUnbans) {
        parts.push(`${stats.unbanCount} ${pluralize("unban", stats.unbanCount)}`);
    }
    if (parts.length === 0) {
        return;
    }

    const statsStartText = stats.startDate ? format(stats.startDate, "yyyy-MM-dd") : undefined;
    let scopeText: string;
    if (!statsStartText) {
        scopeText = "since Bot Bouncer began tracking cumulative summary stats.";
    } else if (stats.startReason === "upgrade") {
        scopeText = `since Bot Bouncer began tracking cumulative summary stats for this subreddit on ${statsStartText} `
            + "after the app was updated. Earlier actions are not included.";
    } else if (stats.startReason === "install") {
        scopeText = `since Bot Bouncer was installed on this subreddit on ${statsStartText}.`;
    } else {
        scopeText = `since Bot Bouncer began tracking cumulative summary stats for this subreddit on ${statsStartText}.`;
    }

    return `Cumulative total: ${parts.join(" and ")} ${scopeText}`;
}

export function buildDigestSummaryComment (subredditName: string, intervalText: string, counts: DigestSummaryCounts, options?: DigestSummaryOptions) {
    const countTexts: string[] = [];

    if (counts.reported !== undefined) {
        countTexts.push(`${counts.reported} reported`);
    }

    if (counts.banned !== undefined) {
        countTexts.push(`${counts.banned} banned`);
    }

    if (counts.unbanned !== undefined) {
        countTexts.push(`${counts.unbanned} unbanned`);
    }

    const previousMessageText = options?.fullAccountListIncluded
        ? " See the previous message for the full account list."
        : " See the previous message for details.";

    return `Digest summary for /r/${subredditName} ${intervalText}: ${countTexts.join("; ")}.${previousMessageText}`;
}

async function sendDigestSummaryComment (
    conversationId: string,
    subredditName: string,
    intervalText: string,
    counts: DigestSummaryCounts,
    context: JobContext,
    options?: DigestSummaryOptions,
) {
    try {
        await context.reddit.modMail.reply({
            conversationId,
            body: buildDigestSummaryComment(subredditName, intervalText, counts, options),
        });
    } catch (e) {
        console.error(`Failed to send compact digest summary comment for conversation ${conversationId}:`, e);
    }
}

export async function sendDailySummary (_: unknown, context: JobContext) {
    const settings = await context.settings.getAll();
    const featureEnabled = settings[AppSetting.Digest] as boolean;

    if (!featureEnabled) {
        return;
    }

    const [frequency] = settings[AppSetting.DigestFrequency] as [DigestFrequency];
    const intervalText = frequency === DigestFrequency.Daily ? "yesterday" : "in the last week";

    if (frequency === DigestFrequency.Weekly && (getDay(new Date()) !== 1)) {
        return;
    }

    const daysToRetrieve: Date[] = [];
    if (frequency === DigestFrequency.Daily) {
        daysToRetrieve.push(subDays(new Date(), 1));
    } else {
        for (let i = 7; i >= 1; i--) {
            daysToRetrieve.push(subDays(new Date(), i));
        }
    }

    const reports: { username: string; type: "automatically" | "manually" }[] = [];
    const bans: ZMember[] = [];
    const unbans: ZMember[] = [];

    for (const date of daysToRetrieve) {
        const reportsSet = await context.redis.hGetAll(getReportsKey(date));
        reports.push(...Object.entries(reportsSet).map(([username, type]) => ({ username, type: type as "automatically" | "manually" })));

        bans.push(...await context.redis.zRange(getBansKey(date), 0, -1));
        unbans.push(...await context.redis.zRange(getUnbansKey(date), 0, -1));
    }

    const reportedEnabled = settings[AppSetting.DigestIncludeReported] as boolean;
    const bannedEnabled = settings[AppSetting.DigestIncludeBanned] as boolean;
    const unbannedEnabled = settings[AppSetting.DigestIncludeUnbanned] as boolean;

    const createSummary = (reportedEnabled && reports.length > 0)
        || (bannedEnabled && bans.length > 0)
        || (unbannedEnabled && unbans.length > 0);

    if (!createSummary) {
        return;
    }

    const summarizeBansAndUnbansByCount = (settings[AppSetting.DigestSummarizeBansAndUnbansByCount] as boolean | undefined) ?? false;
    const includeCumulativeStats = (settings[AppSetting.DigestIncludeCumulativeStats] as boolean | undefined) ?? true;

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const message: json2md.DataObject[] = [];

    if (reportedEnabled) {
        if (reports.length === 0) {
            message.push({ p: `No new potential bots were reported on /r/${subredditName} ${intervalText}.` });
        } else {
            message.push({ p: `The following potential bots were reported on /r/${subredditName} ${intervalText}:` });

            const bullets: string[] = [];
            for (const entry of reports.filter(r => r.type === "manually")) {
                const currentStatus = await getUserStatus(entry.username, context);
                if (currentStatus) {
                    bullets.push(`/u/${entry.username} reported ${entry.type}: now listed as ${currentStatus.userStatus}`);
                } else {
                    bullets.push(`/u/${entry.username} reported ${entry.type}`);
                }
            }
            message.push({ ul: bullets });
        }
    }

    if (bannedEnabled) {
        if (bans.length === 0) {
            message.push({ p: `No new bans were issued by Bot Bouncer on /r/${subredditName} ${intervalText}.` });
        } else if (summarizeBansAndUnbansByCount) {
            message.push({ p: buildCountOnlyActionSummary("banned", bans.length, subredditName, intervalText) });
        } else {
            message.push({ p: `The following users were banned on /r/${subredditName} ${intervalText}:` });
            message.push({ ul: bans.map(ban => `/u/${ban.member}`) });
        }
    }

    if (unbannedEnabled) {
        if (unbans.length === 0) {
            message.push({ p: `No new unbans were processed by Bot Bouncer on /r/${subredditName} ${intervalText}.` });
        } else if (summarizeBansAndUnbansByCount) {
            message.push({ p: buildCountOnlyActionSummary("unbanned", unbans.length, subredditName, intervalText) });
        } else {
            message.push({ p: `The following users were unbanned on /r/${subredditName} ${intervalText}:` });
            message.push({ ul: unbans.map(unban => `/u/${unban.member}`) });
        }
    }

    if (includeCumulativeStats && (bannedEnabled || unbannedEnabled)) {
        const cumulativeSummary = buildCumulativeStatsSummary(await getCumulativeDigestStats(context.redis), bannedEnabled, unbannedEnabled);
        if (cumulativeSummary) {
            message.push({ p: cumulativeSummary });
        }
    }

    try {
        if (await getNewVersionInfo(context)) {
            message.push({ p: `A new version of Bot Bouncer is available. Please check the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appSlug}) for more details.` });
        }
    } catch (e) {
        console.error("Failed to check for new version info:", e);
    }

    message.push({ p: `These notifications can be customised or turned off on the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appSlug}).` });

    const createNewMessage = settings[AppSetting.DigestNewMessageEachDay] as boolean | undefined ?? true;
    const digestSummaryCounts = {
        reported: reportedEnabled ? reports.length : undefined,
        banned: bannedEnabled ? bans.length : undefined,
        unbanned: unbannedEnabled ? unbans.length : undefined,
    };

    const digestSummaryOptions = {
        fullAccountListIncluded: !summarizeBansAndUnbansByCount,
    };

    const digestConversationIdKey = "digestConvesationId";
    const existingConversationId = await context.redis.get(digestConversationIdKey);

    if (!createNewMessage && existingConversationId) {
        await context.reddit.modMail.reply({
            conversationId: existingConversationId,
            body: json2md(message),
        });
        await sendDigestSummaryComment(existingConversationId, subredditName, intervalText, digestSummaryCounts, context, digestSummaryOptions);

        return;
    }

    let subject: string;
    if (!createNewMessage) {
        subject = "Bot Bouncer Action Summary";
    } else if (frequency === DigestFrequency.Daily) {
        subject = `Bot Bouncer Daily Action Summary for ${format(subDays(new Date(), 1), `yyyy-MM-dd`)}, covering midnight to midnight UTC`;
    } else {
        subject = `Bot Bouncer Weekly Action Summary for week ending ${format(subDays(new Date(), 1), `yyyy-MM-dd`)}, covering the last 7 days`;
    }

    const params = {
        subredditId: context.subredditId,
        subject,
        bodyMarkdown: json2md(message),
    };

    let newConversationId: string;
    if (settings[AppSetting.DigestAsModNotification]) {
        newConversationId = await context.reddit.modMail.createModNotification(params);
    } else {
        newConversationId = await context.reddit.modMail.createModInboxConversation(params);
    }

    await sendDigestSummaryComment(newConversationId, subredditName, intervalText, digestSummaryCounts, context, digestSummaryOptions);

    if (!createNewMessage) {
        await context.redis.set(digestConversationIdKey, newConversationId);
    }
}

export async function recordReportForSummary (username: string, redis: RedisClient) {
    const key = getReportsKey(new Date());
    await redis.hSet(key, { [username]: "manually" });
    await expireKeyAt(redis, key, addDays(new Date(), 8));
}

export async function recordBanForSummary (username: string, redis: RedisClient) {
    await ensureDigestCumulativeStatsStart(redis, "tracking");
    await redis.incrBy(CUMULATIVE_BANS_KEY, 1);

    const key = getBansKey(new Date());
    await redis.zAdd(key, { member: username, score: new Date().getTime() });
    await expireKeyAt(redis, key, addDays(new Date(), 8));
}

export async function recordUnbanForSummary (username: string, redis: RedisClient) {
    await ensureDigestCumulativeStatsStart(redis, "tracking");
    await redis.incrBy(CUMULATIVE_UNBANS_KEY, 1);

    const key = getUnbansKey(new Date());
    await redis.zAdd(key, { member: username, score: new Date().getTime() });
    await expireKeyAt(redis, key, addDays(new Date(), 8));
}

export async function removeRecordOfBanForSummary (username: string, redis: RedisClient | TxClientLike) {
    const key = getBansKey(new Date());
    await redis.zRem(key, [username]);
}
