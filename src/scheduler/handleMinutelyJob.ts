import { JobContext } from "@devvit/public-api";
import { processFeedbackQueue } from "../submissionFeedback.js";
import { handleClassificationQueryQueue } from "../modmail/classificationQuery.js";
import { processDelayedMessages } from "../modmail/delayedSend.js";
import { CONTROL_SUBREDDIT } from "../constants.js";

export async function handleMinutelyJob (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Minutely jobs are only run in the control subreddit.");
    }

    await Promise.allSettled([
        processFeedbackQueue(context),
        handleClassificationQueryQueue(context),
        processDelayedMessages(context),
    ]);
}
