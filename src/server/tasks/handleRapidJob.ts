import type { Context } from "hono";
import { context, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT, ControlSubredditJob, processExternalSubmissionsQueue, processQueuedSubmission } from "../core";

export const handleRapidJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Rapid jobs are only run in the control subreddit.");
    }

    await Promise.allSettled([
        processExternalSubmissionsQueue({ name: ControlSubredditJob.ExternalSubmissionsQueue, data: { firstRun: true, jobGuid: crypto.randomUUID() } }),
        processQueuedSubmission(),
    ]);

    return c.json<TaskResponse>({ success: true }, 200);
};
