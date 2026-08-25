import { JobContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { processHighlightedModmailQueue } from "../modmail/unhighlighter.js";
import { gatherTokenStatistics } from "../aiAnalysis/statistics.js";
import { updateClassificationStatistics } from "../statistics/classificationStatistics.js";
import { updateAppealStatistics } from "../statistics/appealStatistics.js";
import { RecoveredAccountsData } from "../types.js";
import { addSeconds } from "date-fns";
import { ModmailArchiverJobData } from "../modmail/modmailArchiver.js";

export async function handleFiveMinutelyJob (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Five minutely jobs are only run in the control subreddit.");
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.CheckPermissionQueueItems,
        runAt: new Date(),
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.AccountReview,
        runAt: new Date(),
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.FlaggedUsersRechecks,
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
        runAt: new Date(),
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.AutoAccountRecovery,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: true,
            jobGuid: crypto.randomUUID(),
        } satisfies RecoveredAccountsData,
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.ModmailArchiver,
        data: {
            jobGuid: crypto.randomUUID(),
            firstRun: true,
        } satisfies ModmailArchiverJobData,
        runAt: addSeconds(new Date(), 10),
    });

    await Promise.allSettled([
        processHighlightedModmailQueue(context),
        gatherTokenStatistics(context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
    ]);
}
