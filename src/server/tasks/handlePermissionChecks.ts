import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { checkPermissionQueueItems, CONTROL_SUBREDDIT, handlePermissionCheckEnqueue } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addSeconds } from "date-fns";

export const handlePermissionCheckEnqueueJob = async (c: Context): Promise<Response> => {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Permission Checks: handlePermissionChecksEnqueueJob must not be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest>();
    if (await hasEventBeenHandled(`job:${request.name}`, { expiration: addSeconds(new Date(), 10) })) {
        return c.json<TaskResponse>({ message: "Event has already been handled." }, 200);
    }

    await handlePermissionCheckEnqueue();

    return c.json<TaskResponse>({ message: "Permission Checks: Enqueue job handled successfully." }, 200);
};

export type CheckPermissionQueueItemJobData = {
    jobGuid?: string;
    firstRun: boolean;
};

export const handleCheckPermissionQueueItemsJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Permission Checks: handleCheckPermissionQueueItemsJob must only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<CheckPermissionQueueItemJobData>>();

    await checkPermissionQueueItems(request);

    return c.json<TaskResponse>({ message: "Permission Checks: Check permission queue items job handled successfully." }, 200);
};
