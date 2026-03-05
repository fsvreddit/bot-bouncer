import { JobContext, TriggerContext } from "@devvit/public-api";
import { updateMainStatisticsPage } from "../statistics/mainStatistics.js";
import { updateSubmitterStatistics } from "../statistics/submitterStatistics.js";
import { createTimeOfSubmissionStatistics } from "../statistics/timeOfSubmissionStatistics.js";
import { checkDataStoreIntegrity, getFullDataStore, removeStaleRecentChangesEntries, UserDetails, UserFlag } from "../dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { updateClassificationStatistics } from "../statistics/classificationStatistics.js";
import { updateAppealStatistics } from "../statistics/appealStatistics.js";
import { addMinutes, subMonths } from "date-fns";
import { updateUsernameStatistics } from "../statistics/usernameStatistics.js";
import { updateDisplayNameStatistics } from "../statistics/displayNameStats.js";
import { updateSocialLinksStatistics } from "../statistics/socialLinksStatistics.js";
import { updateBioStatistics } from "../statistics/userBioStatistics.js";
import { updateDefinedHandlesStats } from "../statistics/definedHandlesStatistics.js";
import { updateFailedFeedbackStorage } from "../submissionFeedback.js";
import { analyseBioText } from "../similarBioTextFinder/bioTextFinder.js";

export const FLAGS_TO_EXCLUDE_FROM_STATS: UserFlag[] = [
    UserFlag.HackedAndRecovered,
];

export interface StatsUserEntry {
    username: string;
    data: UserDetails;
}

export async function perform6HourlyJobs (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("6 hourly jobs are only run in the control subreddit.");
    }

    await removeStaleRecentChangesEntries(context);

    const allData = await getFullDataStore(context, {
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
    });

    const allValues = Object.values(allData);

    await Promise.all([
        context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
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

        context.scheduler.runJob({
            name: ControlSubredditJob.PendingUserFinder,
            runAt: addMinutes(new Date(), 3),
        }),
    ]);

    await Promise.all([
        updateMainStatisticsPage(allValues, context),
        updateSubmitterStatistics(allValues, context),
        createTimeOfSubmissionStatistics(allValues, context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
        updateFailedFeedbackStorage(context),
        analyseBioText(context),
        checkDataStoreIntegrity(context),
    ]);

    console.log("Statistics updated successfully.");
}

export async function perform6HourlyJobsPart2 (_: unknown, context: JobContext) {
    const allData = await getFullDataStore(context, {
        since: subMonths(new Date(), 3),
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
    });

    const allEntries = Object.entries(allData)
        .map(([key, value]) => ({ username: key, data: value } as StatsUserEntry));

    await Promise.all([
        updateUsernameStatistics(allEntries, context),
        updateDisplayNameStatistics(allEntries, context),
        updateSocialLinksStatistics(allEntries, context),
        updateBioStatistics(allEntries, context),
        updateDefinedHandlesStats(allEntries, context),
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
