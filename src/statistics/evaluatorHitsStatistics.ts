import { JobContext } from "@devvit/public-api";
import { EvaluatorStats } from "../handleControlSubAccountEvaluation.js";
import { format } from "date-fns";

export async function updateEvaluatorHitsWikiPage (context: JobContext) {
    const redisKey = "EvaluatorStats";
    const existingStatsVal = await context.redis.get(redisKey);

    const allStats: Record<string, EvaluatorStats> = existingStatsVal ? JSON.parse(existingStatsVal) as Record<string, EvaluatorStats> : {};

    let wikicontent = "Evaluator Name|Hit Count|Last Hit\n";
    wikicontent += ":-|:-|:-\n";

    for (const entry of Object.entries(allStats).map(([name, value]) => ({ name, value }))) {
        wikicontent += `${entry.name}|${entry.value.hitCount}|${format(new Date(entry.value.lastHit), "yyyy-MM-dd HH:mm")}\n`;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    await context.reddit.updateWikiPage({
        subredditName,
        page: "evaluator-hits",
        content: wikicontent,
    });
}
