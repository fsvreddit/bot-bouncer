import { JobContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "./mainStatistics.js";
import { updateSubmitterStatistics } from "./submitterStatistics.js";
import { updateEvaluatorHitsWikiPage } from "./evaluatorHitsStatistics.js";

export async function updateStatisticsPages (_: unknown, context: JobContext) {
    await Promise.all([
        updateMainStatisticsPage(context),
        updateSubmitterStatistics(context),
        updateEvaluatorHitsWikiPage(context),
    ]);
}
