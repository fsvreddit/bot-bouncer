import { JobContext } from "@devvit/public-api";
import { EvaluatorStats } from "../handleControlSubAccountEvaluation.js";
import { format } from "date-fns";
import json2md from "json2md";

export async function updateEvaluatorHitsWikiPage (context: JobContext) {
    const redisKey = "EvaluatorStats";
    const existingStatsVal = await context.redis.get(redisKey);

    const allStats: Record<string, EvaluatorStats> = existingStatsVal ? JSON.parse(existingStatsVal) as Record<string, EvaluatorStats> : {};

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Evaluator Hits Statistics" });

    const tableRows = Object.entries(allStats)
        .map(([name, value]) => ({ name, value }))
        .map(entry => [entry.name, entry.value.hitCount.toLocaleString(), format(new Date(entry.value.lastHit), "yyyy-MM-dd HH:mm")]);

    wikiContent.push({ table: { headers: ["Evaluator Name", "Hit Count", "Last Hit"], rows: tableRows } });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "statistics/evaluator-hits",
        content: json2md(wikiContent),
    });
}
