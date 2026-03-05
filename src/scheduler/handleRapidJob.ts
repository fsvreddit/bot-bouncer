import { JobContext } from "@devvit/public-api";
import { processExternalSubmissionsQueue } from "../externalSubmissions.js";
import { processQueuedSubmission } from "../postCreation.js";
import { CONTROL_SUBREDDIT } from "../constants.js";

export async function handleRapidJob (_: unknown, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Rapid jobs are only run in the control subreddit.");
    }

    await Promise.allSettled([
        processExternalSubmissionsQueue(context),
        processQueuedSubmission(context),
    ]);
}
