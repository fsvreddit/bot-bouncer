import { JobContext, TriggerContext } from "@devvit/public-api";
import { addHours, eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import json2md from "json2md";
import pluralize from "pluralize";

function classificationKeyForDate (date: Date): string {
    return `classificationStatistics-${format(date, "yyyy-MM-dd")}`;
}

export async function storeClassificationEvent (username: string, context: TriggerContext) {
    const redisKey = classificationKeyForDate(new Date());
    const classified = await context.redis.zIncrBy(redisKey, username, 1);
    console.log(`User ${username} has classified ${classified} ${pluralize("account", classified)} today.`);
}

export async function updateClassificationStatistics (context: JobContext) {
    const runRecentlyKey = "classificationStatisticsRunRecently";
    if (await context.redis.exists(runRecentlyKey)) {
        return;
    }
    await context.redis.set(runRecentlyKey, Date.now().toString(), { expiration: addHours(new Date(), 1) });

    const startDate = startOfDay(subDays(new Date(), 7));
    const endDate = startOfDay(subDays(new Date(), 1));
    const dayToDelete = subDays(new Date(), 8);
    const allDaysInRange = eachDayOfInterval({ start: startDate, end: endDate });

    await context.redis.del(classificationKeyForDate(dayToDelete));

    const classificationData: Record<string, number> = {};
    const allClassificationData = await Promise.all(allDaysInRange.map(day => context.redis.zRange(classificationKeyForDate(day), 0, -1)));

    for (const { member, score } of allClassificationData.flat()) {
        if (!classificationData[member]) {
            classificationData[member] = 0;
        }
        classificationData[member] += score;
    }

    if (Object.keys(classificationData).length === 0) {
        console.log("No classification data found for the last week.");
        return;
    }

    const wikiContent: json2md.DataObject[] = [
        { h1: "Classification statistics" },
        { p: "This lists all users who have classified accounts from Pending within the last week." },
    ];

    const headers = ["Username", "Classifications"];
    const rows = Object.entries(classificationData).map(([username, count]) => [`/u/${username}`, count.toLocaleString()]);

    wikiContent.push({ table: { headers, rows } });

    wikiContent.push({ h2: "Yesterday's activity (UTC)" });

    const yesterdayData = await context.redis.zRange(classificationKeyForDate(subDays(new Date(), 1)), 0, -1);
    if (yesterdayData.length === 0) {
        wikiContent.push({ p: "No classifications were made yesterday." });
    } else {
        const yesterdayHeaders = ["Username", "Classifications"];
        const yesterdayRows = yesterdayData.map(({ member, score }) => [`/u/${member}`, score.toLocaleString()]);
        wikiContent.push({ table: { headers: yesterdayHeaders, rows: yesterdayRows } });
    }

    wikiContent.push({ h2: "Today's activity since midnight UTC" });

    const todaysData = await context.redis.zRange(classificationKeyForDate(new Date()), 0, -1);
    if (todaysData.length === 0) {
        wikiContent.push({ p: "No classifications have been made today." });
    } else {
        const todayHeaders = ["Username", "Classifications"];
        const todayRows = todaysData.map(({ member, score }) => [`/u/${member}`, score.toLocaleString()]);
        wikiContent.push({ table: { headers: todayHeaders, rows: todayRows } });
    }

    wikiContent.push({ p: "This page updates every hour, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/classificationstats",
        content: json2md(wikiContent),
    });
}
