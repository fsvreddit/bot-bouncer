import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT } from "../core";
import { checkUserFlaggedRechecksQueue } from "../core/userEvaluation";

export type FlaggedRechecksQueueJobData = {
    firstRun: boolean;
    jobGuid: string;
};

export const handleFlaggedUserRechecksJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Flagged User Rechecks: handleFlaggedUserRechecksJob should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<FlaggedRechecksQueueJobData>>();

    await checkUserFlaggedRechecksQueue(request);

    return c.json<TaskResponse>({ message: "Flagged user rechecks handled" }, 200);
};
