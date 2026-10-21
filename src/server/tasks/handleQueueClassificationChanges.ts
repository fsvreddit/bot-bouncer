import { TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { queueRecentReclassifications } from "../core";

export const handleQueueClassificationChangesJob = async (c: Context): Promise<Response> => {
    await queueRecentReclassifications();

    return c.json<TaskResponse>({ message: "Queued recent reclassifications successfully." }, 200);
};
