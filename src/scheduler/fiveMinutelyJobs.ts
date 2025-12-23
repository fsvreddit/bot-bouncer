import { JobContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";

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
        name: ControlSubredditJob.CheckUpgradeNotifierForLegacySubs,
        runAt: new Date(),
        data: { firstRun: true },
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.AccountReview,
        runAt: new Date(),
        data: { firstRun: true },
    });
}
