import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { generateBioStatisticsReport, updateBioStatisticsJob } from "../core/controlSubCore/statistics";

export type BioStatsJobData = {
    statsId: string;
    batch?: number;
    jobGuid: string;
};

export const handleUpdateBioStatsJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<BioStatsJobData>>();

    await updateBioStatisticsJob(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};

export const handleGenerateBioStatisticsReportJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<BioStatsJobData>>();

    await generateBioStatisticsReport(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
