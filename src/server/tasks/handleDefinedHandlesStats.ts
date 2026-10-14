import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { definedHandlesStatsInitializer, gatherDefinedHandlesStats, storeDefinedHandlesDataJob } from "../core/controlSubCore/statistics";

export type DefinedHandlesStatsInitializerJobData = {
    jobGuid: string;
    firstRun: boolean;
    prefixes: string[];
};

export const handleDefinedHandlesStatsInitializerJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<DefinedHandlesStatsInitializerJobData>>();

    await definedHandlesStatsInitializer(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};

export type DefinedHandlesStatsJobData = {
    jobGuid: string;
    firstRun: boolean;
};

export const handleGatherDefinedHandlesStatsJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<DefinedHandlesStatsJobData>>();

    await gatherDefinedHandlesStats(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};

export type StoreDefinedHandlesDataJobData = {
    username?: string;
    jobGuid?: string;
};

export const handleStoreDefinedHandlesDataJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<StoreDefinedHandlesDataJobData>>();

    await storeDefinedHandlesDataJob(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
