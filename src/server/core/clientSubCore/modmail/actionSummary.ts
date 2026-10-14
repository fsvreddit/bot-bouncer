import { context, reddit, redis, settings, ZMember } from "@devvit/web/server";
import { addDays, format, getDay, subDays } from "date-fns";
import { AppSetting, DigestFrequency, expireKeyAt, getUserStatus } from "../..";
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

interface DigestSummaryCounts {
    reported: number | undefined;
    banned: number | undefined;
    unbanned: number | undefined;
}

function buildDigestSummaryComment (subredditName: string, intervalText: string, counts: DigestSummaryCounts) {
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

    return `Digest summary for /r/${subredditName} ${intervalText}: ${countTexts.join("; ")}. See the previous message for the full account list.`;
}

async function sendDigestSummaryComment (
    conversationId: string,
    subredditName: string,
    intervalText: string,
    counts: DigestSummaryCounts,
) {
    try {
        await reddit.modMail.reply({
            conversationId,
            body: buildDigestSummaryComment(subredditName, intervalText, counts),
        });
    } catch (e) {
        console.error(`Failed to send compact digest summary comment for conversation ${conversationId}:`, e);
    }
}

export async function sendDigestSummary () {
    const appSettings = await settings.getAll();
    const featureEnabled = appSettings[AppSetting.Digest] as boolean;

    if (!featureEnabled) {
        return;
    }

    const [frequency] = appSettings[AppSetting.DigestFrequency] as [DigestFrequency];
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
        const reportsSet = await redis.hGetAll(getReportsKey(date));
        reports.push(...Object.entries(reportsSet).map(([username, type]) => ({ username, type: type as "automatically" | "manually" })));

        bans.push(...await redis.zRange(getBansKey(date), 0, -1));
        unbans.push(...await redis.zRange(getUnbansKey(date), 0, -1));
    }

    const reportedEnabled = appSettings[AppSetting.DigestIncludeReported] as boolean;
    const bannedEnabled = appSettings[AppSetting.DigestIncludeBanned] as boolean;
    const unbannedEnabled = appSettings[AppSetting.DigestIncludeUnbanned] as boolean;

    const createSummary = (reportedEnabled && reports.length > 0)
        || (bannedEnabled && bans.length > 0)
        || (unbannedEnabled && unbans.length > 0);

    if (!createSummary) {
        return;
    }

    const subredditName = context.subredditName;

    const message: json2md.DataObject[] = [];

    if (reportedEnabled) {
        if (reports.length === 0) {
            message.push({ p: `No new potential bots were reported on /r/${subredditName} ${intervalText}.` });
        } else {
            message.push({ p: `The following potential bots were reported on /r/${subredditName} ${intervalText}:` });

            const bullets: string[] = [];
            for (const entry of reports.filter(r => r.type === "manually")) {
                const currentStatus = await getUserStatus(entry.username);
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

    message.push({ p: `These notifications can be customised or turned off on the [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/${context.appSlug}).` });

    const createNewMessage = appSettings[AppSetting.DigestNewMessageEachDay] as boolean | undefined ?? true;
    const digestSummaryCounts = {
        reported: reportedEnabled ? reports.length : undefined,
        banned: bannedEnabled ? bans.length : undefined,
        unbanned: unbannedEnabled ? unbans.length : undefined,
    };

    const digestConversationIdKey = "digestConvesationId";
    const existingConversationId = await redis.get(digestConversationIdKey);

    if (!createNewMessage && existingConversationId) {
        await reddit.modMail.reply({
            conversationId: existingConversationId,
            body: json2md(message),
        });
        await sendDigestSummaryComment(existingConversationId, subredditName, intervalText, digestSummaryCounts);

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
    if (appSettings[AppSetting.DigestAsModNotification]) {
        newConversationId = await reddit.modMail.createModNotification(params);
    } else {
        newConversationId = await reddit.modMail.createModInboxConversation(params);
    }

    await sendDigestSummaryComment(newConversationId, subredditName, intervalText, digestSummaryCounts);

    if (!createNewMessage) {
        await redis.set(digestConversationIdKey, newConversationId);
    }
}

export async function recordReportForSummary (username: string) {
    const key = getReportsKey(new Date());
    await redis.hSet(key, { [username]: "manually" });
    await expireKeyAt(key, addDays(new Date(), 8));
}

export async function recordBanForSummary (username: string) {
    const key = getBansKey(new Date());
    await redis.zAdd(key, { member: username, score: new Date().getTime() });
    await expireKeyAt(key, addDays(new Date(), 8));
}

export async function recordUnbanForSummary (username: string) {
    const key = getUnbansKey(new Date());
    await redis.zAdd(key, { member: username, score: new Date().getTime() });
    await expireKeyAt(key, addDays(new Date(), 8));
}

export async function removeRecordOfBanForSummary (username: string) {
    const key = getBansKey(new Date());
    await redis.zRem(key, [username]);
}
