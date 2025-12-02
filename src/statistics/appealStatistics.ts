import { JobContext, TriggerContext } from "@devvit/public-api";
import { eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import { deleteKeyForAppeal, isActiveAppeal } from "../modmail/controlSubModmail.js";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
import { ModmailMessage } from "../modmail/modmail.js";

function getKeyForDate (date = new Date()): string {
    return `appealStatistics~${format(date, "yyyy-MM-dd")}`;
}

export async function markAppealAsHandled (modmail: ModmailMessage, context: TriggerContext) {
    if (modmail.isInternal || !modmail.messageAuthorIsMod || modmail.messageAuthor === context.appName) {
        return;
    }

    const activeAppeal = await isActiveAppeal(modmail.conversationId, context);
    if (!activeAppeal) {
        return;
    }

    const handled = await context.redis.zIncrBy(getKeyForDate(), modmail.messageAuthor, 1);
    await deleteKeyForAppeal(modmail.conversationId, context);

    console.log(`User ${modmail.messageAuthor} handled an appeal. Total handled today: ${handled}`);
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

    const wikiContent: MarkdownEntry[] = [
        { h1: "Appeal statistics" },
        { p: "This lists all users who have handled ban appeals within the last week." },
    ];

    const headers = ["Username", "Appeals"];
    const rows = Object.entries(appealData).map(([username, count]) => [`/u/${username}`, count.toLocaleString()]);

    wikiContent.push({ table: { headers, rows } });
    wikiContent.push({ p: "This page updates every 6 hours, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/appealstats",
        content: tsMarkdown(wikiContent),
    });
}
