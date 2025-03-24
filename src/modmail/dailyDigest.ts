import { JobContext, TriggerContext } from "@devvit/public-api";
import { format, subDays } from "date-fns";
import { getUserStatus } from "../dataStore.js";
import { AppSetting } from "../settings.js";

function getReportsKey (date: Date) {
    return `digest:reports:${format(date, `yyyy-MM-dd`)}`;
}

function getBansKey (date: Date) {
    return `digest:bans:${format(date, `yyyy-MM-dd`)}`;
}

export async function sendDailyDigest (_: unknown, context: JobContext) {
    const yesterday = subDays(new Date(), 1);
    const reportsKey = getReportsKey(yesterday);
    const bansKey = getBansKey(subDays(new Date(), 1));

    const reportsSet = await context.redis.hGetAll(reportsKey);
    const reports = Object.entries(reportsSet).map(([username, type]) => ({ username, type }));
    const bans = await context.redis.zRange(bansKey, 0, -1);

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const featureEnabled = await context.settings.get<boolean>(AppSetting.DailyDigest);

    const promises: Promise<unknown>[] = [];

    if (featureEnabled && (reports.length > 0 || bans.length > 0)) {
        const subject = `Bot Bouncer Daily Digest for ${format(yesterday, `yyyy-MM-dd`)}, covering midnight to midnight UTC`;
        let message = "";

        if (reports.length === 0) {
            message += `No new bots were detected or reported on /r/${subredditName} yesterday.\n\n`;
        } else {
            message += `The following potential bots were detected or reported on /r/${subredditName} yesterday:\n\n`;
            for (const entry of reports) {
                const currentStatus = await getUserStatus(entry.username, context);
                if (currentStatus) {
                    message += `* /u/${entry.username} reported ${entry.type}: now listed as ${currentStatus.userStatus}\n`;
                } else {
                    message += `* /u/${entry.username} reported ${entry.type}\n`;
                }
            }
            message += "\n";
        }

        if (bans.length === 0) {
            message += `No new bans were issued by Bot Bouncer on /r/${subredditName} yesterday.`;
        } else {
            message += `The following users were banned on /r/${subredditName} yesterday:\n\n`;
            for (const username of bans.map(ban => ban.member)) {
                message += `* /u/${username}\n`;
            }
            message += "\n";
        }

        message += `If you no longer want to receive these notifications, you can turn them off on the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appName}).`;

        promises.push(context.reddit.modMail.createModInboxConversation({
            subredditId: context.subredditId,
            subject,
            bodyMarkdown: message,
        }));
    }

    promises.push(
        context.redis.del(reportsKey),
        context.redis.del(bansKey),
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

export async function removeRecordOfBanForDigest (username: string, context: TriggerContext | JobContext) {
    const key = getBansKey(new Date());
    await context.redis.zRem(key, [username]);
}
