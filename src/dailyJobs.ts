import { JobContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "./statistics/mainStatistics.js";
import { updateSubmitterStatistics } from "./statistics/submitterStatistics.js";
import { updateEvaluatorHitsWikiPage } from "./statistics/evaluatorHitsStatistics.js";
import { createTimeOfSubmissionStatistics } from "./statistics/timeOfSubmissionStatistics.js";
import { getFullDataStore, UserDetails } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { updateClassificationStatistics } from "./statistics/classificationStatistics.js";
import { updateAppealStatistics } from "./statistics/appealStatistics.js";
import { addMinutes } from "date-fns";
import { updateUsernameStatistics } from "./statistics/usernameStatistics.js";
import { updateDisplayNameStatistics } from "./statistics/displayNameStats.js";

export async function performDailyJobs (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.log("Daily jobs are only run in the control subreddit.");
        return;
    }

    const allDataRaw = await getFullDataStore(context);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const allEntries = Object.entries(allDataRaw)
        .map(([key, value]) => [key, JSON.parse(value) as UserDetails]) as [string, UserDetails][];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const allValues = allEntries.map(([_, value]) => value);

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
        updateMainStatisticsPage(allValues, context),
        updateSubmitterStatistics(allValues, context),
        updateEvaluatorHitsWikiPage(context),
        createTimeOfSubmissionStatistics(allValues, context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
        updateUsernameStatistics(allEntries, context),
        updateDisplayNameStatistics(allEntries, context),
    ]);
}
