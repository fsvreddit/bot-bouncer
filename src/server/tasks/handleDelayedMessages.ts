import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { processDelayedMessages } from "../core/controlSubCore/modmail";

export type DelayedMessageJobData = {
    firstRun: boolean;
    jobGuid?: string;
};

export const handleDelayedMessageJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<DelayedMessageJobData>>();

    await processDelayedMessages(request);

    return c.json<TaskResponse>({ success: true }, 200);
};
