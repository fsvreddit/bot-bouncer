import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT } from "../core";
import { processPendingUserReevaluationQueue } from "../core/userEvaluation";

export type PendingUserReevaluationJobData = {
    firstRun: boolean;
    jobGuid: string;
};

export const handlePendingUserReevaluationJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Pending User Reevaluation: handlePendingUserReevaluationJob should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<PendingUserReevaluationJobData>>();

    await processPendingUserReevaluationQueue(request);

    return c.json<TaskResponse>({ message: "Pending user reevaluation handled" }, 200);
};
