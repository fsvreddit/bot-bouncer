import { JobContext, TxClientLike } from "@devvit/public-api";
import { format, subDays } from "date-fns";
import { getUserStatus } from "../dataStore.js";
import { AppSetting } from "../settings.js";
import json2md from "json2md";

function getReportsKey (date: Date) {
    return `digest:reports:${format(date, `yyyy-MM-dd`)}`;
}

function getBansKey (date: Date) {
    return `digest:bans:${format(date, `yyyy-MM-dd`)}`;
}

function getUnbansKey (date: Date) {
    return `digest:unbans:${format(date, `yyyy-MM-dd`)}`;
}

export async function sendDailyDigest (_: unknown, context: JobContext) {
    const yesterday = subDays(new Date(), 1);
    const reportsKey = getReportsKey(yesterday);
    const bansKey = getBansKey(yesterday);
    const unbansKey = getUnbansKey(yesterday);

    const reportsSet = await context.redis.hGetAll(reportsKey);
    const reports = Object.entries(reportsSet).map(([username, type]) => ({ username, type }));
    const bans = await context.redis.zRange(bansKey, 0, -1);
    const unbans = await context.redis.zRange(unbansKey, 0, -1);

    const settings = await context.settings.getAll();
    const featureEnabled = settings[AppSetting.DailyDigest] as boolean;
    const reportedEnabled = settings[AppSetting.DailyDigestIncludeReported] as boolean;
    const bannedEnabled = settings[AppSetting.DailyDigestIncludeBanned] as boolean;
    const unbannedEnabled = settings[AppSetting.DailyDigestIncludeUnbanned] as boolean;

    const createSummary = featureEnabled && (
        (reportedEnabled && reports.length > 0)
        || (bannedEnabled && bans.length > 0)
        || (unbannedEnabled && unbans.length > 0)
    );

    const promises: Promise<unknown>[] = [];

    if (createSummary) {
        const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

        const subject = `Bot Bouncer Daily Digest for ${format(yesterday, `yyyy-MM-dd`)}, covering midnight to midnight UTC`;
        const message: json2md.DataObject[] = [];

        if (reportedEnabled) {
            if (reports.length === 0) {
                message.push({ p: `No new potential bots were detected or reported on /r/${subredditName} yesterday.` });
            } else {
                message.push({ p: `The following potential bots were detected or reported on /r/${subredditName} yesterday:` });

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
                message.push({ p: `No new bans were issued by Bot Bouncer on /r/${subredditName} yesterday.` });
            } else {
                message.push({ p: `The following users were banned on /r/${subredditName} yesterday:` });
                message.push({ ul: bans.map(ban => `/u/${ban.member}`) });
            }
        }

        if (unbannedEnabled) {
            if (unbans.length === 0) {
                message.push({ p: `No new unbans were processed by Bot Bouncer on /r/${subredditName} yesterday.` });
            } else {
                message.push({ p: `The following users were unbanned on /r/${subredditName} yesterday:` });
                message.push({ ul: unbans.map(unban => `/u/${unban.member}`) });
            }
        }

        message.push({ p: `These notifications can be customised or turned off on the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appName}).` });

        promises.push(context.reddit.modMail.createModInboxConversation({
            subredditId: context.subredditId,
            subject,
            bodyMarkdown: json2md(message),
        }));
    }

    promises.push(
        context.redis.del(reportsKey),
        context.redis.del(bansKey),
        context.redis.del(unbansKey),
    );

    await Promise.all(promises);
}

export async function recordReportForDigest (username: string, type: "automatically" | "manually", txn: TxClientLike) {
    const key = getReportsKey(new Date());
    await txn.hSet(key, { [username]: type });
    await txn.expire(key, 60 * 60 * 24 * 2);
}

export async function recordBanForDigest (username: string, txn: TxClientLike) {
    const key = getBansKey(new Date());
    await txn.zAdd(key, { member: username, score: new Date().getTime() });
    await txn.expire(key, 60 * 60 * 24 * 2);
}

export async function recordUnbanForDigest (username: string, txn: TxClientLike) {
    const key = getUnbansKey(new Date());
    await txn.zAdd(key, { member: username, score: new Date().getTime() });
    await txn.expire(key, 60 * 60 * 24 * 2);
}

export async function removeRecordOfBanForDigest (username: string, txn: TxClientLike) {
    const key = getBansKey(new Date());
    await txn.zRem(key, [username]);
}
