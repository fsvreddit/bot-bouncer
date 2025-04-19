import { JobContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "./mainStatistics.js";
import { updateSubmitterStatistics } from "./submitterStatistics.js";
import { updateEvaluatorHitsWikiPage } from "./evaluatorHitsStatistics.js";
import { createTimeOfSubmissionStatistics } from "./timeOfSubmissionStatistics.js";
import { getFullDataStore } from "../dataStore.js";

export async function updateStatisticsPages (_: unknown, context: JobContext) {
    const allData = await getFullDataStore(context);

    await Promise.all([
        updateMainStatisticsPage(allData, context),
        updateSubmitterStatistics(allData, context),
        updateEvaluatorHitsWikiPage(context),
        createTimeOfSubmissionStatistics(allData, context),
    ]);
}
