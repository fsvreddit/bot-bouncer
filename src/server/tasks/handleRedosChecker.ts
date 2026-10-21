import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { redosChecker } from "../core/userEvaluation";

export type RedosCheckerJobData = {
    firstRun?: boolean;
    finalise?: boolean;
    batchNumber?: number;
    modName?: string;
    jobGuid?: string;
};

export const handleRedosCheckerJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<RedosCheckerJobData>>();

    await redosChecker(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
