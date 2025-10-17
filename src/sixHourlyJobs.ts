import { JobContext, TriggerContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "./statistics/mainStatistics.js";
import { updateSubmitterStatistics } from "./statistics/submitterStatistics.js";
import { updateEvaluatorHitsWikiPage } from "./statistics/evaluatorHitsStatistics.js";
import { createTimeOfSubmissionStatistics } from "./statistics/timeOfSubmissionStatistics.js";
import { getFullDataStore, UserDetails, UserFlag } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { updateClassificationStatistics } from "./statistics/classificationStatistics.js";
import { updateAppealStatistics } from "./statistics/appealStatistics.js";
import { addMinutes } from "date-fns";
import { updateUsernameStatistics } from "./statistics/usernameStatistics.js";
import { updateDisplayNameStatistics } from "./statistics/displayNameStats.js";
import { updateSocialLinksStatistics } from "./statistics/socialLinksStatistics.js";
import { updateBioStatistics } from "./statistics/userBioStatistics.js";
import { updateDefinedHandlesStats } from "./statistics/definedHandlesStatistics.js";
import { pendingUserFinder } from "./statistics/pendingUserFinder.js";
import { updateFailedFeedbackStorage } from "./submissionFeedback.js";

const FLAGS_TO_EXCLUDE_FROM_STATS: UserFlag[] = [
    UserFlag.HackedAndRecovered,
];

export interface StatsUserEntry {
    username: string;
    data: UserDetails;
}

export async function getAllValuesForStats (context: TriggerContext) {
    const allDataRaw = await getFullDataStore(context);

    const allEntries = Object.entries(allDataRaw)
        .map(([key, value]) => ({ username: key, data: JSON.parse(value) as UserDetails } as StatsUserEntry))
        .filter(entry => !FLAGS_TO_EXCLUDE_FROM_STATS.some(flag => entry.data.flags?.includes(flag)));

    const allValues = allEntries.map(({ data }) => data);

    return { allEntries, allValues };
}

export async function perform6HourlyJobs (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.log("Daily jobs are only run in the control subreddit.");
        return;
    }

    const { allValues } = await getAllValuesForStats(context);

    await Promise.all([
        context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: new Date(),
            data: { firstRun: true },
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.PerformCleanupMaintenance,
            runAt: new Date(),
            data: { firstRun: true },
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
            runAt: addMinutes(new Date(), 2),
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.Perform6HourlyJobsPart2,
            runAt: addMinutes(new Date(), 1),
        }),
    ]);

    await Promise.all([
        updateMainStatisticsPage(allValues, context),
        updateSubmitterStatistics(allValues, context),
        updateEvaluatorHitsWikiPage(context),
        createTimeOfSubmissionStatistics(allValues, context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
        updateFailedFeedbackStorage(context),
    ]);

    console.log("Statistics updated successfully.");
}

export async function perform6HourlyJobsPart2 (_: unknown, context: JobContext) {
    const { allEntries } = await getAllValuesForStats(context);
    await Promise.all([
        updateUsernameStatistics(allEntries, context),
        updateDisplayNameStatistics(allEntries, context),
        updateSocialLinksStatistics(allEntries, context),
        updateBioStatistics(allEntries, context),
        updateDefinedHandlesStats(allEntries, context),
        pendingUserFinder(allEntries, context),
    ]);
}

export async function checkIfStatsNeedUpdating (context: TriggerContext) {
    const lastRevisionKey = "lastRemoteStatsUpdate";
    const lastRevisionVal = await context.redis.get(lastRevisionKey);
    const wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, "statistics/update_stats");
    if (lastRevisionVal === wikiPage.revisionId) {
        return;
    }

    console.log("Stats wiki page has been updated, scheduling stats update job.");

    await context.scheduler.runJob({
        name: ControlSubredditJob.Perform6HourlyJobs,
        runAt: new Date(),
    });

    const newEntry = await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/update_stats",
        content: "false",
    });

    await context.redis.set(lastRevisionKey, newEntry.revisionId);
}
