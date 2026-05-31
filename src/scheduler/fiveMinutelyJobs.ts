import { JobContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { processHighlightedModmailQueue } from "../modmail/unhighlighter.js";
import { gatherTokenStatistics } from "../aiAnalysis/statistics.js";
import { updateClassificationStatistics } from "../statistics/classificationStatistics.js";
import { updateAppealStatistics } from "../statistics/appealStatistics.js";

export async function handleFiveMinutelyJob (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Five minutely jobs are only run in the control subreddit.");
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.CheckPermissionQueueItems,
        runAt: new Date(),
        data: { firstRun: true },
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.AccountReview,
        runAt: new Date(),
        data: { firstRun: true },
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.FlaggedUsersRechecks,
        data: { firstRun: true },
        runAt: new Date(),
    });

    await Promise.allSettled([
        processHighlightedModmailQueue(context),
        gatherTokenStatistics(context),
        updateClassificationStatistics(context),
        updateAppealStatistics(context),
    ]);
}
