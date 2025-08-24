import { JobContext, TriggerContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "./statistics/mainStatistics.js";
import { updateSubmitterStatistics } from "./statistics/submitterStatistics.js";
import { updateEvaluatorHitsWikiPage } from "./statistics/evaluatorHitsStatistics.js";
import { createTimeOfSubmissionStatistics } from "./statistics/timeOfSubmissionStatistics.js";
import { getFullDataStore, UserDetails } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { updateClassificationStatistics } from "./statistics/classificationStatistics.js";
import { updateAppealStatistics } from "./statistics/appealStatistics.js";
import { addMinutes, addSeconds } from "date-fns";
import { updateUsernameStatistics } from "./statistics/usernameStatistics.js";
import { updateDisplayNameStatistics } from "./statistics/displayNameStats.js";
import { updateSocialLinksStatistics } from "./statistics/socialLinksStatistics.js";
import { updateBioStatistics } from "./statistics/userBioStatistics.js";
import { updateDefinedHandlesStats } from "./statistics/definedHandlesStatistics.js";
import { pendingUserFinder } from "./statistics/pendingUserFinder.js";

async function getAllValues (context: TriggerContext) {
    const allDataRaw = await getFullDataStore(context);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const allEntries = Object.entries(allDataRaw)
        .map(([key, value]) => [key, JSON.parse(value) as UserDetails]) as [string, UserDetails][];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const allValues = allEntries.map(([_, value]) => value);

    return { allEntries, allValues };
}

export async function perform6HourlyJobs (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.log("Daily jobs are only run in the control subreddit.");
        return;
    }

    const { allValues } = await getAllValues(context);

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

        context.scheduler.runJob({
            name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
            runAt: addSeconds(new Date(), 60),
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.Perform6HourlyJobsPart2,
            runAt: addMinutes(new Date(), 2),
        }),
    ]);

    await Promise.all([
        updateMainStatisticsPage(allValues, context),
        updateSubmitterStatistics(allValues, context),
        updateEvaluatorHitsWikiPage(context),
        createTimeOfSubmissionStatistics(allValues, context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
    ]);

    console.log("Statistics updated successfully.");
}

export async function perform6HourlyJobsPart2 (_: unknown, context: JobContext) {
    const { allEntries } = await getAllValues(context);
    await Promise.all([
        updateUsernameStatistics(allEntries, context),
        updateDisplayNameStatistics(allEntries, context),
        updateSocialLinksStatistics(allEntries, context),
        updateBioStatistics(allEntries, context),
        updateDefinedHandlesStats(allEntries, context),
        pendingUserFinder(allEntries, context),
    ]);
}
