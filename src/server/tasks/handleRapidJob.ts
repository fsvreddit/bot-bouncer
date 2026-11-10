import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT, ControlSubredditJob, processExternalSubmissionsQueue, processQueuedSubmission } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addSeconds } from "date-fns";

export const handleRapidJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Rapid jobs are only run in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest>();
    if (await hasEventBeenHandled(`job:${request.name}`, { expiration: addSeconds(new Date(), 5) })) {
        return c.json<TaskResponse>({ message: "Event has already been handled." }, 200);
    }

    await Promise.allSettled([
        processExternalSubmissionsQueue({ name: ControlSubredditJob.ExternalSubmissionsQueue, data: { firstRun: true, jobGuid: crypto.randomUUID() } }),
        processQueuedSubmission(),
    ]);

    return c.json<TaskResponse>({ success: true }, 200);
};
