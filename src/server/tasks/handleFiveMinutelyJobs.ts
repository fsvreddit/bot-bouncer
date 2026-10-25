import { context, scheduler, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../core";
import { AccountReviewJobData, CheckPermissionQueueItemJobData, FlaggedRechecksQueueJobData, ModmailArchiverJobData, PendingUserReevaluationJobData, RecoveredAccountsData, UnprocessedSubmissionsJobData } from ".";
import { addSeconds } from "date-fns";
import { processHighlightedModmailQueue } from "../core/controlSubCore/modmail";
import { gatherTokenStatistics } from "../core/controlSubCore/aiAnalysis";
import { updateAppealStatistics, updateClassificationStatistics } from "../core/controlSubCore/statistics";

export const handleFiveMinutelyJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Five minutely jobs are only run in the control subreddit.");
    }

    await scheduler.runJob<CheckPermissionQueueItemJobData>({
        name: ControlSubredditJob.CheckPermissionQueueItems,
        runAt: new Date(),
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
    });

    await scheduler.runJob<AccountReviewJobData>({
        name: ControlSubredditJob.AccountReview,
        runAt: new Date(),
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
    });

    await scheduler.runJob<FlaggedRechecksQueueJobData>({
        name: ControlSubredditJob.FlaggedUsersRechecks,
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
        runAt: new Date(),
    });

    await scheduler.runJob<RecoveredAccountsData>({
        name: ControlSubredditJob.AutoAccountRecovery,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: true,
            jobGuid: crypto.randomUUID(),
        },
    });

    await scheduler.runJob<ModmailArchiverJobData>({
        name: ControlSubredditJob.ModmailArchiver,
        data: {
            jobGuid: crypto.randomUUID(),
            firstRun: true,
        },
        runAt: addSeconds(new Date(), 10),
    });

    await scheduler.runJob<PendingUserReevaluationJobData>({
        name: ControlSubredditJob.PendingUserReevaluation,
        data: {
            firstRun: true,
            jobGuid: crypto.randomUUID(),
        },
        runAt: addSeconds(new Date(), 30),
    });

    await scheduler.runJob<UnprocessedSubmissionsJobData>({
        name: ControlSubredditJob.UnprocessedSubmissionsHandler,
        data: {
            jobGuid: crypto.randomUUID(),
        },
        runAt: addSeconds(new Date(), 15),
    });

    await Promise.allSettled([
        processHighlightedModmailQueue(),
        gatherTokenStatistics(),
        updateClassificationStatistics(),
        updateAppealStatistics(),
    ]);

    return c.json<TaskResponse>({ success: true }, 200);
};
