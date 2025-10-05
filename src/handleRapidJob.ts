import { JobContext } from "@devvit/public-api";
import { processExternalSubmissionsQueue } from "./externalSubmissions.js";
import { processQueuedSubmission } from "./postCreation.js";
import { processFeedbackQueue } from "./submissionFeedback.js";

export async function handleRapidJob (_: unknown, context: JobContext) {
    const startTime = Date.now();
    await processExternalSubmissionsQueue(context);
    if (Date.now() - startTime > 2000) {
        // If processing took too long, skip processing the post queue to avoid overrunning the job time limit.
        return;
    }

    await processQueuedSubmission(context);

    if (Date.now() - startTime > 6000) {
        // If processing took too long, skip processing the feedback queue to avoid overrunning the job time limit.
        return;
    }
    await processFeedbackQueue(context);
}
