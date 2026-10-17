import type { Context } from "hono";
import { TaskResponse } from "@devvit/web/server";
import { processModqueueRemovalStore } from "../core/clientSubCore";

export const handleModQueueRemovalJob = async (c: Context): Promise<Response> => {
    await processModqueueRemovalStore();
    return c.json<TaskResponse>({ success: true }, 200);
};
