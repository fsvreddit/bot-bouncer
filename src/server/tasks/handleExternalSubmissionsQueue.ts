import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { processExternalSubmissionsQueue } from "../core";

export type ExternalSubmissionQueueData = {
    firstRun: boolean;
    jobGuid: string;
};

export const handleExternalSubmissionsQueueJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<ExternalSubmissionQueueData>>();

    await processExternalSubmissionsQueue(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
