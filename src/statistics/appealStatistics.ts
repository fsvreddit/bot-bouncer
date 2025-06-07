import { JobContext, MessageData, TriggerContext } from "@devvit/public-api";
import { eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import { deleteKeyForAppeal, isActiveAppeal } from "../modmail/controlSubModmail.js";
import json2md from "json2md";

function getKeyForDate (date = new Date()): string {
    return `appealStatistics~${format(date, "yyyy-MM-dd")}`;
}

export async function markAppealAsHandled (conversationId: string, currentMessage: MessageData, context: TriggerContext) {
    if (!currentMessage.author?.name || currentMessage.isInternal || !currentMessage.author.isMod || currentMessage.author.name === context.appName) {
        return;
    }

    const activeAppeal = await isActiveAppeal(conversationId, context);
    if (!activeAppeal) {
        console.log(`No active appeal found for ${conversationId}, may have been handled already.`);
        return;
    }

    const handled = await context.redis.zIncrBy(getKeyForDate(), currentMessage.author.name, 1);
    await deleteKeyForAppeal(conversationId, context);

    console.log(`User ${currentMessage.author.name} handled an appeal. Total handled today: ${handled}`);
}

export async function updateAppealStatistics (context: JobContext) {
    const startDate = startOfDay(subDays(new Date(), 7));
    const endDate = startOfDay(subDays(new Date(), 1));
    const dayToDelete = subDays(new Date(), 8);
    const allDaysInRange = eachDayOfInterval({ start: startDate, end: endDate });

    await context.redis.del(getKeyForDate(dayToDelete));

    const appealData: Record<string, number> = {};
    const allClassificationData = await Promise.all(allDaysInRange.map(day => context.redis.zRange(getKeyForDate(day), 0, -1)));

    for (const { member, score } of allClassificationData.flat()) {
        if (!appealData[member]) {
            appealData[member] = 0;
        }
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
    wikiContent.push({ p: "This page updates once a day at midnight UTC, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/appealstats",
        content: json2md(wikiContent),
    });
}
