import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { updateMainStatisticsPage } from "../core/controlSubCore/statistics";

export type UpdateMainStatisticsPageJobData = {
    jobGuid?: string;
};

export const handleMainStatisticsJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<UpdateMainStatisticsPageJobData>>();

    await updateMainStatisticsPage(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
