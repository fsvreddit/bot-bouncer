import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { evaluateKarmaFarmingSubs, queueKarmaFarmingSubs } from "../core";

export type EvaluateKarmaFarmingSubsEventData = {
    firstRun?: boolean;
    cohort?: "evens" | "odds";
    jobGuid?: string;
};

export const handleEvaluateKarmaFarmingSubsJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<EvaluateKarmaFarmingSubsEventData>>();

    await evaluateKarmaFarmingSubs(request);
    return c.json<TaskResponse>({ success: true }, 200);
};

export const handleQueueKarmaFarmingSubsJob = async (c: Context): Promise<Response> => {
    await queueKarmaFarmingSubs();
    return c.json<TaskResponse>({ success: true }, 200);
};
