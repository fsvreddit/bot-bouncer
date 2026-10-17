import { context, reddit, redis } from "@devvit/web/server";
import { ModmailMessage } from "../..";
import { deleteKeyForAppeal, isActiveAppeal } from "../modmail";
import { addHours, eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import json2md from "json2md";

function getKeyForDate (date = new Date()): string {
    return `appealStatistics~${format(date, "yyyy-MM-dd")}`;
}

export async function recordAppealHandled (modUsername: string): Promise<number> {
    return await redis.zIncrBy(getKeyForDate(), modUsername, 1);
}

export async function markAppealAsHandledByMod (modmail: ModmailMessage) {
    if (modmail.isInternal || !modmail.messageAuthorIsMod || modmail.messageAuthor === context.appSlug) {
        return;
    }

    const activeAppeal = await isActiveAppeal(modmail.conversationId);
    if (!activeAppeal) {
        return;
    }

    const handled = await recordAppealHandled(modmail.messageAuthor);
    await deleteKeyForAppeal(modmail.conversationId);

    console.log(`User ${modmail.messageAuthor} handled an appeal. Total handled today: ${handled}`);
}

export async function updateAppealStatistics () {
    const runRecentlyKey = "appealStatisticsRunRecently";
    if (await redis.exists(runRecentlyKey)) {
        return;
    }
    await redis.set(runRecentlyKey, Date.now().toString(), { expiration: addHours(new Date(), 1) });

    const startDate = startOfDay(subDays(new Date(), 7));
    const endDate = startOfDay(subDays(new Date(), 1));
    const dayToDelete = subDays(new Date(), 8);
    const allDaysInRange = eachDayOfInterval({ start: startDate, end: endDate });

    await redis.del(getKeyForDate(dayToDelete));

    const appealData: Record<string, number> = {};
    const allClassificationData = await Promise.all(allDaysInRange.map(day => redis.zRange(getKeyForDate(day), 0, -1)));

    for (const { member, score } of allClassificationData.flat()) {
        appealData[member] ??= 0;
        appealData[member] += score;
    }

    if (Object.keys(appealData).length === 0) {
        console.log("No appeal data found for the last week.");
        return;
    }

    const wikiContent: json2md.DataObject[] = [
        { h1: "Appeal statistics" },
        { p: "This lists all users who have handled ban appeals within the last week." },
    ];

    const headers = ["Username", "Appeals"];
    const rows = Object.entries(appealData).map(([username, count]) => [`/u/${username}`, count.toLocaleString()]);

    wikiContent.push({ table: { headers, rows } });

    wikiContent.push({ h2: "Yesterday's activity (UTC)" });

    const yesterdayData = await redis.zRange(getKeyForDate(subDays(new Date(), 1)), 0, -1);
    if (yesterdayData.length === 0) {
        wikiContent.push({ p: "No appeals were handled yesterday." });
    } else {
        const yesterdayHeaders = ["Username", "Appeals"];
        const yesterdayRows = yesterdayData.map(({ member, score }) => [`/u/${member}`, score.toLocaleString()]);
        wikiContent.push({ table: { headers: yesterdayHeaders, rows: yesterdayRows } });
    }

    wikiContent.push({ h2: "Today's activity since midnight UTC" });

    const todayData = await redis.zRange(getKeyForDate(), 0, -1);
    if (todayData.length === 0) {
        wikiContent.push({ p: "No appeals have been handled today." });
    } else {
        const todayHeaders = ["Username", "Appeals"];
        const todayRows = todayData.map(({ member, score }) => [`/u/${member}`, score.toLocaleString()]);
        wikiContent.push({ table: { headers: todayHeaders, rows: todayRows } });
    }

    wikiContent.push({ p: "This page updates every hour, and may update more frequently." });

    await reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: "statistics/appealstats",
        content: json2md(wikiContent),
    });
}
