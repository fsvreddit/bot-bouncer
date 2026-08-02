import { JobContext } from "@devvit/public-api";
import { processFeedbackQueue } from "../submissionFeedback.js";
import { handleClassificationQueryQueue } from "../modmail/classificationQuery.js";
import { areAnyDelayedMessagesQueued } from "../modmail/delayedSend.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { checkBotPostFreshness } from "./botPostMonitor.js";

export async function handleMinutelyJob (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Minutely jobs are only run in the control subreddit.");
    }

    if (await areAnyDelayedMessagesQueued(context)) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.ProcessDelayedMessages,
            data: { firstRun: true, jobGuid: crypto.randomUUID() },
            runAt: new Date(),
        });
    }

    await Promise.allSettled([
        processFeedbackQueue(context),
        handleClassificationQueryQueue(context),
        checkBotPostFreshness(context),
    ]);
}
