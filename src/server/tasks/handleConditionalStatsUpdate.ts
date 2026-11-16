import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { Context } from "hono";
import { conditionalStatsUpdate, StatisticsName } from "../core/controlSubCore/statistics";

export type ConditionalStatsUpdateJobData = {
    jobGuid: string;
    phase: "initial" | "gather" | "process";
    lookBackMonths?: number;
    prefixes?: string[];
    statsNames?: StatisticsName[];
};

export const handleConditionalStatsUpdateJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<ConditionalStatsUpdateJobData>>();

    await conditionalStatsUpdate(request);

    return c.json<TaskResponse>({
        success: true,
    }, 200);
};
