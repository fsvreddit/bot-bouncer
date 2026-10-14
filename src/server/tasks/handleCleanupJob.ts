import { TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { cleanupDeletedAccounts } from "../core/cleanup";

export type CleanupJobData = {
    jobGuid?: string;
    firstRun: boolean;
};

export const handleCleanupJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<CleanupJobData>>();

    await cleanupDeletedAccounts(jobRequest);

    return c.json<TaskResponse>({ message: "cleanup job completed" }, 200);
};
