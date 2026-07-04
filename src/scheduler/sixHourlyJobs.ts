import { JobContext, TriggerContext } from "@devvit/public-api";
import { updateSubmitterStatistics } from "../statistics/submitterStatistics.js";
import { createTimeOfSubmissionStatistics } from "../statistics/timeOfSubmissionStatistics.js";
import { ALL_POTENTIAL_USER_PREFIXES, checkDataStoreIntegrity, getFullDataStore, removeStaleRecentChangesEntries, UserDetails, UserFlag } from "../dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { addMinutes, subMonths } from "date-fns";
import { updateUsernameStatistics } from "../statistics/usernameStatistics.js";
import { updateDisplayNameStatistics } from "../statistics/displayNameStats.js";
import { updateSocialLinksStatistics } from "../statistics/socialLinksStatistics.js";
import { updateBioStatistics } from "../statistics/userBioStatistics.js";
import { updateFailedFeedbackStorage } from "../submissionFeedback.js";
import { analyseBioText } from "../similarBioTextFinder/bioTextFinder.js";
import { DefinedHandlesStatsInitializerJobData } from "../statistics/definedHandlesStatistics.js";
import { updateHackedProfileFingerprintStatistics } from "../hackedProfileFingerprints.js";

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

    console.log("6 Hourly Jobs: Starting execution of 6 hourly jobs.");

    await removeStaleRecentChangesEntries(context);
    console.log("6 Hourly Jobs: Removed stale recent changes entries.");

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
            name: ControlSubredditJob.DefinedHandlesStatisticsInitialiser,
            runAt: addMinutes(new Date(), 2),
            data: {
                firstRun: true,
                prefixes: ALL_POTENTIAL_USER_PREFIXES,
            } satisfies DefinedHandlesStatsInitializerJobData,
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.PendingUserFinder,
            runAt: addMinutes(new Date(), 3),
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.MainStatisticsUpdate,
            runAt: addMinutes(new Date(), 4),
        }),
    ]);
    console.log("6 Hourly Jobs: Scheduled subsequent jobs.");

    const allData = await getFullDataStore(context, {
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
        since: subMonths(new Date(), 1),
    });
    console.log("6 Hourly Jobs: Retrieved full data store.");

    const allValues = Object.values(allData);
    console.log(`6 Hourly Jobs: Processing statistics for ${allValues.length} user records.`);

    await Promise.all([
        createTimeOfSubmissionStatistics(allValues, context),
        updateFailedFeedbackStorage(context),
        analyseBioText(context),
        checkDataStoreIntegrity(context),
    ]);

    console.log("Statistics updated successfully.");
}

export async function perform6HourlyJobsPart2 (_: unknown, context: JobContext) {
    const allData = await getFullDataStore(context, {
        since: subMonths(new Date(), 3),
    });

    const allEntries = Object.entries(allData)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        .map(([key, value]) => ({ username: key, data: value } as StatsUserEntry));
    const statsEntries = allEntries.filter(entry => !entry.data.flags?.some(flag => FLAGS_TO_EXCLUDE_FROM_STATS.includes(flag)));

    await Promise.all([
        updateUsernameStatistics(statsEntries, context),
        updateDisplayNameStatistics(statsEntries, context),
        updateSocialLinksStatistics(statsEntries, context),
        updateBioStatistics(statsEntries, context),
        updateSubmitterStatistics(statsEntries, context),
        updateHackedProfileFingerprintStatistics(allEntries, context),
    ]);
}

export async function checkIfStatsNeedUpdating (context: TriggerContext) {
    const lastRevisionKey = "lastRemoteStatsUpdate";
    const lastRevisionVal = await context.redis.get(lastRevisionKey);
    const wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, "statistics/update_stats");
    if (lastRevisionVal === wikiPage.revisionId) {
        return;
    }

    if (wikiPage.revisionAuthor?.username === context.appSlug) {
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
