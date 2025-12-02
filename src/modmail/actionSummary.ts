import { JobContext, RedisClient, TxClientLike, ZMember } from "@devvit/public-api";
import { addDays, format, getDay, subDays } from "date-fns";
import { getUserStatus } from "../dataStore.js";
import { AppSetting, DigestFrequency } from "../settings.js";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
import { expireKeyAt } from "devvit-helpers";
import { getNewVersionInfo } from "../upgradeNotifier.js";

function getReportsKey (date: Date) {
    return `digest:reports:${format(date, `yyyy-MM-dd`)}`;
}

function getBansKey (date: Date) {
    return `digest:bans:${format(date, `yyyy-MM-dd`)}`;
}

function getUnbansKey (date: Date) {
    return `digest:unbans:${format(date, `yyyy-MM-dd`)}`;
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

    if (createSummary) {
        const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

        let subject: string;
        if (frequency === DigestFrequency.Daily) {
            subject = `Bot Bouncer Daily Action Summary for ${format(subDays(new Date(), 1), `yyyy-MM-dd`)}, covering midnight to midnight UTC`;
        } else {
            subject = `Bot Bouncer Weekly Action Summary for week ending ${format(subDays(new Date(), 1), `yyyy-MM-dd`)}, covering the last 7 days`;
        }

        const message: MarkdownEntry[] = [];

        if (reportedEnabled) {
            if (reports.length === 0) {
                message.push({ p: `No new potential bots were detected or reported on /r/${subredditName} ${intervalText}.` });
            } else {
                message.push({ p: `The following potential bots were detected or reported on /r/${subredditName} ${intervalText}:` });

                const bullets: string[] = [];
                for (const entry of reports) {
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
            } else {
                message.push({ p: `The following users were banned on /r/${subredditName} ${intervalText}:` });
                message.push({ ul: bans.map(ban => `/u/${ban.member}`) });
            }
        }

        if (unbannedEnabled) {
            if (unbans.length === 0) {
                message.push({ p: `No new unbans were processed by Bot Bouncer on /r/${subredditName} ${intervalText}.` });
            } else {
                message.push({ p: `The following users were unbanned on /r/${subredditName} ${intervalText}:` });
                message.push({ ul: unbans.map(unban => `/u/${unban.member}`) });
            }
        }

        try {
            if (await getNewVersionInfo(context)) {
                message.push({ p: `A new version of Bot Bouncer is available. Please check the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appName}) for more details.` });
            }
        } catch (e) {
            console.error("Failed to check for new version info:", e);
        }

        message.push({ p: `These notifications can be customised or turned off on the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appName}).` });

        const params = {
            subredditId: context.subredditId,
            subject,
            bodyMarkdown: tsMarkdown(message),
        };

        if (settings[AppSetting.DigestAsModNotification]) {
            await context.reddit.modMail.createModNotification(params);
        } else {
            await context.reddit.modMail.createModInboxConversation(params);
        }
    }
}

export async function recordReportForSummary (username: string, type: "automatically" | "manually", redis: RedisClient) {
    const key = getReportsKey(new Date());
    await redis.hSet(key, { [username]: type });
    await expireKeyAt(redis, key, addDays(new Date(), 8));
}

export async function recordBanForSummary (username: string, redis: RedisClient) {
    const key = getBansKey(new Date());
    await redis.zAdd(key, { member: username, score: new Date().getTime() });
    await expireKeyAt(redis, key, addDays(new Date(), 8));
}

export async function recordUnbanForSummary (username: string, redis: RedisClient) {
    const key = getUnbansKey(new Date());
    await redis.zAdd(key, { member: username, score: new Date().getTime() });
    await expireKeyAt(redis, key, addDays(new Date(), 8));
}

export async function removeRecordOfBanForSummary (username: string, redis: RedisClient | TxClientLike) {
    const key = getBansKey(new Date());
    await redis.zRem(key, [username]);
}
