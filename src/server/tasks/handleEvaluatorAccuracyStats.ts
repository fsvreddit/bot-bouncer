import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { buildEvaluatorAccuracyStatistics, initialiseEvaluatorAccuracyStatistics } from "../core/controlSubCore/statistics";

export type EvaluatorAccuracyInitialiserData = {
    jobGuid: string;
    prefixes?: string[];
};

export const handleEvaluatorAccuracyInitializerJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<EvaluatorAccuracyInitialiserData>>();

    await initialiseEvaluatorAccuracyStatistics(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};

export type BuildEvaluatorAccuracyStatisticsJobData = {
    jobGuid: string;
};

export const handleBuildEvaluatorAccuracyStatisticsJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<BuildEvaluatorAccuracyStatisticsJobData>>();

    await buildEvaluatorAccuracyStatistics(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
