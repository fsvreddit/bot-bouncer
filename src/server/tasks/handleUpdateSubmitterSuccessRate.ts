import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { updateSubmitterSuccessRate } from "../core/controlSubCore/statistics";

export type UpdateSubmitterSuccessRateJobData = {
    jobGuid: string;
    username: string;
};

export const handleUpdateSubmitterSuccessRateJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Update Submitter Success Rate: handleUpdateSubmitterSuccessRate should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<UpdateSubmitterSuccessRateJobData>>();

    if (await hasEventBeenHandled(`job:${request.data.jobGuid}`)) {
        return c.json<TaskResponse>({ message: "Job already handled" }, 200);
    }

    await updateSubmitterSuccessRate(request.data.username);

    return c.json<TaskResponse>({ message: "Update Submitter Success Rate handled" }, 200);
};
