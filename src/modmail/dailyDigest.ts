import { JobContext, TriggerContext } from "@devvit/public-api";
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

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const featureEnabled = await context.settings.get<boolean>(AppSetting.DailyDigest);

    const promises: Promise<unknown>[] = [];

    if (featureEnabled && (reports.length > 0 || bans.length > 0)) {
        const subject = `Bot Bouncer Daily Digest for ${format(yesterday, `yyyy-MM-dd`)}, covering midnight to midnight UTC`;
        const message: json2md.DataObject[] = [];

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

        if (bans.length === 0) {
            message.push({ p: `No new bans were issued by Bot Bouncer on /r/${subredditName} yesterday.` });
        } else {
            message.push({ p: `The following users were banned on /r/${subredditName} yesterday:` });
            message.push({ ul: bans.map(ban => `/u/${ban.member}`) });
        }

        if (unbans.length === 0) {
            message.push({ p: `No new unbans were processed by Bot Bouncer on /r/${subredditName} yesterday.` });
        } else {
            message.push({ p: `The following users were unbanned on /r/${subredditName} yesterday:` });
            message.push({ ul: unbans.map(unban => `/u/${unban.member}`) });
        }

        message.push({ p: `If you no longer want to receive these notifications, you can turn them off on the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appName}).` });

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

export async function recordReportForDigest (username: string, type: "automatically" | "manually", context: TriggerContext | JobContext) {
    const key = getReportsKey(new Date());
    await context.redis.hSet(key, { [username]: type });
    await context.redis.expire(key, 60 * 60 * 24 * 2);
}

export async function recordBanForDigest (username: string, context: TriggerContext | JobContext) {
    const key = getBansKey(new Date());
    await context.redis.zAdd(key, { member: username, score: new Date().getTime() });
    await context.redis.expire(key, 60 * 60 * 24 * 2);
}

export async function recordUnbanForDigest (username: string, context: TriggerContext | JobContext) {
    const key = getUnbansKey(new Date());
    await context.redis.zAdd(key, { member: username, score: new Date().getTime() });
    await context.redis.expire(key, 60 * 60 * 24 * 2);
}

export async function removeRecordOfBanForDigest (username: string, context: TriggerContext | JobContext) {
    const key = getBansKey(new Date());
    await context.redis.zRem(key, [username]);
}
