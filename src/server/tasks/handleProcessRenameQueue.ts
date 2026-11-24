import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { Context } from "hono";
import { processRenameQueue } from "../core";

export type ProcessRenameQueueJobData = {
    jobGuid: string;
};

export const handleProcessRenameQueueJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<ProcessRenameQueueJobData>>();

    await processRenameQueue(request.data);

    return c.json<TaskResponse>({ message: "Process rename queue job completed successfully" }, 200);
};
