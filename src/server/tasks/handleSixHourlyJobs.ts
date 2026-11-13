import { context, redis, scheduler, TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { ALL_POTENTIAL_USER_PREFIXES, CONTROL_SUBREDDIT, ControlSubredditJob, getDataStoreFiltered, getFullDataStore, removeStaleRecentChangesEntries, UserDetails } from "../core";
import { addMinutes, addSeconds, subMonths } from "date-fns";
import { analyseBioText } from "../core/controlSubCore/similarBioTextFinder";
import { expireKeyAt, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { DefinedHandlesStatsInitializerJobData, DeleteRecordsForRemovedUsersData, EvaluatorAccuracyInitialiserData, PendingUserFinderJobData, UpdateMainStatisticsPageJobData } from ".";
import { createTimeOfSubmissionStatistics, FLAGS_TO_EXCLUDE_FROM_STATS, socialLinksStatisticsJobRunner, StatsUserEntry, updateBioStatistics, updateDisplayNameStatistics, updateSubmitterStatistics, updateUsernameStatistics } from "../core/controlSubCore/statistics";
import { fromPairs } from "lodash-es";
import pluralize from "pluralize";

export type SixHourlyJobData = {
    jobGuid?: string;
};

export const handleSixHourlyJob = async (c: Context): Promise<Response> => {
    const event = await c.req.json<TaskRequest<SixHourlyJobData | undefined>>();

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("6 hourly jobs are only run in the control subreddit.");
    }

    const jobGuid = event.data?.jobGuid;
    if (await hasEventBeenHandled(`job:${jobGuid ?? event.name}`, { expiration: addMinutes(new Date(), 5) })) {
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

        scheduler.runJob<DeleteRecordsForRemovedUsersData>({
            name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
            runAt: addMinutes(new Date(), 2),
            data: { jobGuid: crypto.randomUUID() },
        }),

        scheduler.runJob<SixHourlyJobPart2Data>({
            name: ControlSubredditJob.Perform6HourlyJobsPart2,
            runAt: addMinutes(new Date(), 3),
            data: {
                jobGuid: crypto.randomUUID(),
                prefixes: ALL_POTENTIAL_USER_PREFIXES,
            },
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

    if (allValues.length === 0) {
        console.error("6 Hourly Jobs: No user entries found in the data store.");
        return c.json<TaskResponse>({ message: "No user entries found in the data store." }, 200);
    }

    await Promise.all([
        createTimeOfSubmissionStatistics(allValues),
        analyseBioText(),
    ]);

    console.log("Statistics updated successfully.");

    return c.json<TaskResponse>({ message: "6 Hourly Jobs completed successfully." }, 200);
};

export type SixHourlyJobPart2Data = {
    jobGuid: string;
    prefixes: string[];
};

export const handleSixHourlyJobPart2 = async (c: Context): Promise<Response> => {
    const event = await c.req.json<TaskRequest<SixHourlyJobPart2Data>>();

    const jobGuid = event.data.jobGuid;
    if (await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`6 Hourly Jobs Part 2: Job with guid ${jobGuid} has already been handled, skipping.`);
        return c.json<TaskResponse>({ message: "Job has already been handled." }, 200);
    }

    console.log(`6 Hourly Jobs Part 2: Handling job.`);

    const allDataKey = "SixHourlyJobPart2Data";

    if (event.data.prefixes.length > 0) {
        console.log(`6 Hourly Jobs Part 2: Processing ${event.data.prefixes.length} prefixes.`);
        const runLimit = addSeconds(new Date(), 15);

        let prefixesProcessed = 0;
        while (event.data.prefixes.length > 0 && new Date() < runLimit) {
            const firstPrefix = event.data.prefixes.shift();
            if (!firstPrefix) {
                break;
            }

            const data = await getDataStoreFiltered(firstPrefix, {
                since: subMonths(new Date(), 3),
                omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
            });

            const dataToSave = Object.entries(data).map(([key, value]) => ([key, JSON.stringify(value)]));
            if (dataToSave.length > 0) {
                await redis.hSet(allDataKey, fromPairs(dataToSave));
                await expireKeyAt(allDataKey, addMinutes(new Date(), 10));
            }
            prefixesProcessed++;
        }

        console.log(`6 Hourly Jobs Part 2: Processed ${prefixesProcessed} ${pluralize("prefix", prefixesProcessed)}, ${event.data.prefixes.length} remaining.`);

        await scheduler.runJob<SixHourlyJobPart2Data>({
            name: ControlSubredditJob.Perform6HourlyJobsPart2,
            runAt: addSeconds(new Date(), 2),
            data: {
                jobGuid: crypto.randomUUID(),
                prefixes: event.data.prefixes,
            },
        });
    }

    const allData = await redis.hGetAll(allDataKey);

    const allEntries = Object.entries(allData)
        .map(([key, value]) => ({ username: key, data: JSON.parse(value) as UserDetails } satisfies StatsUserEntry));

    await redis.del(allDataKey);

    if (allEntries.length === 0) {
        console.error("6 Hourly Jobs Part 2: No user entries found in the data store.");
        return c.json<TaskResponse>({ message: "No user entries found in the data store." }, 200);
    }

    await Promise.all([
        updateUsernameStatistics(allEntries),
        updateDisplayNameStatistics(allEntries),
        socialLinksStatisticsJobRunner(),
        updateBioStatistics(allEntries),
        updateSubmitterStatistics(allEntries),
    ]);

    return c.json<TaskResponse>({ message: "6 Hourly Jobs Part 2 completed successfully." }, 200);
};
