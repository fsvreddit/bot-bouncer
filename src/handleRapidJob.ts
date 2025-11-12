import { JobContext } from "@devvit/public-api";
import { processExternalSubmissionsQueue } from "./externalSubmissions.js";
import { processQueuedSubmission } from "./postCreation.js";
import { processFeedbackQueue } from "./submissionFeedback.js";
import { handleClassificationQueryQueue } from "./modmail/classificationQuery.js";

export async function handleRapidJob (_: unknown, context: JobContext) {
    await Promise.allSettled([
        processExternalSubmissionsQueue(context),
        processQueuedSubmission(context),
        processFeedbackQueue(context),
        handleClassificationQueryQueue(context),
    ]);
}
