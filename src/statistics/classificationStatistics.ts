import { JobContext, TriggerContext } from "@devvit/public-api";
import { eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
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

    const wikiContent: MarkdownEntry[] = [
        { h1: "Classification statistics" },
        { p: "This lists all users who have classified accounts from Pending within the last week." },
    ];

    const headers = ["Username", "Classifications"];
    const rows = Object.entries(classificationData).map(([username, count]) => [`/u/${username}`, count.toLocaleString()]);

    wikiContent.push({ table: { headers, rows } });
    wikiContent.push({ p: "This page updates every 6 hours, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/classificationstats",
        content: tsMarkdown(wikiContent),
    });
}
