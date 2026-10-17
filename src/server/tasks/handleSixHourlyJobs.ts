import { context, scheduler, TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { ALL_POTENTIAL_USER_PREFIXES, CONTROL_SUBREDDIT, ControlSubredditJob, getFullDataStore, removeStaleRecentChangesEntries } from "../core";
import { addMinutes, subMonths } from "date-fns";
import { analyseBioText } from "../core/controlSubCore/similarBioTextFinder";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { DefinedHandlesStatsInitializerJobData, EvaluatorAccuracyInitialiserData, PendingUserFinderJobData, UpdateMainStatisticsPageJobData } from ".";
import { createTimeOfSubmissionStatistics, FLAGS_TO_EXCLUDE_FROM_STATS, StatsUserEntry, updateBioStatistics, updateDisplayNameStatistics, updateSocialLinksStatistics, updateSubmitterStatistics, updateUsernameStatistics } from "../core/controlSubCore/statistics";

export type SixHourlyJobData = {
    jobGuid?: string;
};

export const handleSixHourlyJob = async (c: Context): Promise<Response> => {
    const event = await c.req.json<TaskRequest<SixHourlyJobData | undefined>>();

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("6 hourly jobs are only run in the control subreddit.");
    }

    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`6 Hourly Jobs: Job with guid ${jobGuid} has already been handled, skipping.`);
        return c.json<TaskResponse>({ message: "Job has already been handled." }, 200);
    }

    console.log("6 Hourly Jobs: Starting execution of 6 hourly jobs.");

    await removeStaleRecentChangesEntries();
    console.log("6 Hourly Jobs: Removed stale recent changes entries.");

    await Promise.all([
        scheduler.runJob<EvaluatorAccuracyInitialiserData>({
            name: ControlSubredditJob.EvaluatorAccuracyStatisticsInitialiser,
            runAt: addMinutes(new Date(), 1),
            data: { jobGuid: crypto.randomUUID() },
        }),

        scheduler.runJob({
            name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
            runAt: addMinutes(new Date(), 2),
            data: { jobGuid: crypto.randomUUID() },
        }),

        scheduler.runJob<SixHourlyJobData>({
            name: ControlSubredditJob.Perform6HourlyJobsPart2,
            runAt: addMinutes(new Date(), 3),
            data: { jobGuid: crypto.randomUUID() },
        }),

        scheduler.runJob<DefinedHandlesStatsInitializerJobData>({
            name: ControlSubredditJob.DefinedHandlesStatisticsInitialiser,
            runAt: addMinutes(new Date(), 10),
            data: {
                firstRun: true,
                jobGuid: crypto.randomUUID(),
                prefixes: ALL_POTENTIAL_USER_PREFIXES,
            },
        }),

        scheduler.runJob<PendingUserFinderJobData>({
            name: ControlSubredditJob.PendingUserFinder,
            runAt: addMinutes(new Date(), 5),
            data: { jobGuid: crypto.randomUUID() },
        }),

        scheduler.runJob<UpdateMainStatisticsPageJobData>({
            name: ControlSubredditJob.MainStatisticsUpdate,
            runAt: addMinutes(new Date(), 4),
            data: { jobGuid: crypto.randomUUID() },
        }),
    ]);
    console.log("6 Hourly Jobs: Scheduled subsequent jobs.");

    const allData = await getFullDataStore({
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
        since: subMonths(new Date(), 1),
    });
    console.log("6 Hourly Jobs: Retrieved full data store.");

    const allValues = Object.values(allData);
    console.log(`6 Hourly Jobs: Processing statistics for ${allValues.length} user records.`);

    await Promise.all([
        createTimeOfSubmissionStatistics(allValues),
        analyseBioText(),
    ]);

    console.log("Statistics updated successfully.");

    return c.json<TaskResponse>({ message: "6 Hourly Jobs completed successfully." }, 200);
};

export const handleSixHourlyJobPart2 = async (c: Context): Promise<Response> => {
    const event = await c.req.json<TaskRequest<SixHourlyJobData | undefined>>();

    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`6 Hourly Jobs Part 2: Job with guid ${jobGuid} has already been handled, skipping.`);
        return c.json<TaskResponse>({ message: "Job has already been handled." }, 200);
    }

    const allData = await getFullDataStore({
        since: subMonths(new Date(), 3),
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
    });

    const allEntries = Object.entries(allData)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        .map(([key, value]) => ({ username: key, data: value } as StatsUserEntry));

    await Promise.all([
        updateUsernameStatistics(allEntries),
        updateDisplayNameStatistics(allEntries),
        updateSocialLinksStatistics(allEntries),
        updateBioStatistics(allEntries),
        updateSubmitterStatistics(allEntries),
    ]);

    return c.json<TaskResponse>({ message: "6 Hourly Jobs Part 2 completed successfully." }, 200);
};
