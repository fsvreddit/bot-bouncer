import { JobContext, TriggerContext } from "@devvit/public-api";
import { addHours, eachDayOfInterval, format, startOfDay, subDays } from "date-fns";
import json2md from "json2md";
import { AppealTrackedOutcome } from "../modmail/appealOutcomes.js";

function getAutomaticDenialKeyForDate (date = new Date()): string {
    return `appealOutcomeStatistics~${AppealTrackedOutcome.AutomaticDenial}~${format(date, "yyyy-MM-dd")}`;
}

export async function markAutomaticAppealDenial (configName: string, context: TriggerContext | JobContext) {
    const count = await context.redis.zIncrBy(getAutomaticDenialKeyForDate(), configName, 1);
    console.log(`Appeals: Automatic denial tracked for ${configName}. Total for this rule today: ${count}`);
}

function aggregateSortedSetData (data: { member: string; score: number }[][]): Record<string, number> {
    const results: Record<string, number> = {};
    for (const { member, score } of data.flat()) {
        if (!results[member]) {
            results[member] = 0;
        }
        results[member] += score;
    }
    return results;
}

function pushAutomaticDenialTable (wikiContent: json2md.DataObject[], heading: string, data: Record<string, number>, emptyMessage: string) {
    wikiContent.push({ h2: heading });

    if (Object.keys(data).length === 0) {
        wikiContent.push({ p: emptyMessage });
        return;
    }

    const headers = ["Appeal config", "Automatic denials"];
    const rows = Object.entries(data)
        .sort(([, a], [, b]) => b - a)
        .map(([configName, count]) => [configName, count.toLocaleString()]);
    wikiContent.push({ table: { headers, rows } });
}

export async function updateAppealOutcomeStatistics (context: JobContext) {
    const runRecentlyKey = "appealOutcomeStatisticsRunRecently";
    if (await context.redis.exists(runRecentlyKey)) {
        return;
    }
    await context.redis.set(runRecentlyKey, Date.now().toString(), { expiration: addHours(new Date(), 1) });

    const startDate = startOfDay(subDays(new Date(), 7));
    const endDate = startOfDay(subDays(new Date(), 1));
    const dayToDelete = subDays(new Date(), 8);
    const allDaysInRange = eachDayOfInterval({ start: startDate, end: endDate });

    await context.redis.del(getAutomaticDenialKeyForDate(dayToDelete));

    const allAutomaticDenialData = await Promise.all(allDaysInRange.map(day => context.redis.zRange(getAutomaticDenialKeyForDate(day), 0, -1)));
    const automaticDenialData = aggregateSortedSetData(allAutomaticDenialData);

    const wikiContent: json2md.DataObject[] = [
        { h1: "Appeal outcome statistics" },
        { p: "This lists tracked automatic appeal outcomes from the last week." },
        { p: "Only appeal config entries with `trackOutcome: automaticDenial` are counted." },
    ];

    pushAutomaticDenialTable(
        wikiContent,
        "Automatic denials in the last 7 days",
        automaticDenialData,
        "No automatic denials were tracked in the last week.",
    );

    const yesterdayData = await context.redis.zRange(getAutomaticDenialKeyForDate(subDays(new Date(), 1)), 0, -1);
    pushAutomaticDenialTable(
        wikiContent,
        "Yesterday's automatic denials (UTC)",
        aggregateSortedSetData([yesterdayData]),
        "No automatic denials were tracked yesterday.",
    );

    const todayData = await context.redis.zRange(getAutomaticDenialKeyForDate(), 0, -1);
    pushAutomaticDenialTable(
        wikiContent,
        "Today's automatic denials since midnight UTC",
        aggregateSortedSetData([todayData]),
        "No automatic denials have been tracked today.",
    );

    wikiContent.push({ p: "This page updates every hour, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/appealoutcomes",
        content: json2md(wikiContent),
    });
}
