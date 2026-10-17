import { TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { handleClassificationChanges } from "../core";

export type HandleClassificationChangesData = {
    firstRun: boolean;
    jobGuid: string;
};

export const handleClassificationChangesJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<HandleClassificationChangesData>>();

    await handleClassificationChanges(jobRequest);
    return c.json<TaskResponse>({ message: "Classification changes handled successfully." }, 200);
};
