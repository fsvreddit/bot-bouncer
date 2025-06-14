import { JobContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "./statistics/mainStatistics.js";
import { updateSubmitterStatistics } from "./statistics/submitterStatistics.js";
import { updateEvaluatorHitsWikiPage } from "./statistics/evaluatorHitsStatistics.js";
import { createTimeOfSubmissionStatistics } from "./statistics/timeOfSubmissionStatistics.js";
import { getFullDataStore } from "./dataStore.js";
import { ControlSubredditJob } from "./constants.js";
import { updateClassificationStatistics } from "./statistics/classificationStatistics.js";
import { updateAppealStatistics } from "./statistics/appealStatistics.js";
import { addMinutes } from "date-fns";

export async function performDailyJobs (_: unknown, context: JobContext) {
    const allData = await getFullDataStore(context);

    await Promise.all([
        context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: new Date(),
            data: { firstRun: true },
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.CleanupPostStore,
            runAt: addMinutes(new Date(), 1),
            data: { firstRun: true },
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.PerformCleanupMaintenance,
            runAt: new Date(),
            data: { firstRun: true },
        }),
    ]);

    await Promise.all([
        updateMainStatisticsPage(allData, context),
        updateSubmitterStatistics(allData, context),
        updateEvaluatorHitsWikiPage(context),
        createTimeOfSubmissionStatistics(allData, context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
    ]);
}
