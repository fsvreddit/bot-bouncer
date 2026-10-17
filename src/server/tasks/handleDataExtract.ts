import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { continueDataExtract, startDataExtract } from "../core/controlSubCore/modmail/dataExtract";

export type DataExtractJobData = {
    extractId: string;
    conversationId: string;
    request: string;
    prefixes?: string[];
    jobGuid: string;
};

export const handleStartDataExtract = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<DataExtractJobData>>();

    await startDataExtract(request);
    return c.json<TaskResponse>({ success: true }, 200);
};

export const handleContinueDataExtract = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<DataExtractJobData>>();

    await continueDataExtract(request);
    return c.json<TaskResponse>({ success: true }, 200);
};
