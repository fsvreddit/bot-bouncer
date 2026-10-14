import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { Context } from "hono";
import { generateOpenAISummary, openAISummaryLookupAndRespond, updateTokenStatsMessage } from "../core/controlSubCore/aiAnalysis";

export type OpenAISummaryGatherData = {
    jobGuid?: string;
    mode: "auto" | "manual";
    username: string;
    conversationId?: string;
    postId?: string;
    promptName?: string;
};

export const handleOpenAISummaryGatherJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<OpenAISummaryGatherData>>();

    await generateOpenAISummary(request);

    return c.json<TaskResponse>({ success: true }, 200);
};

export type OpenAISummaryLookupAndRespondData = {
    jobGuid: string;
    username: string;
    conversationId?: string;
    postId?: string;
    model: string;
    temperature?: number;
    prompt: string;
    payload: string;
};

export const handleOpenAILookupAndRespondJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<OpenAISummaryLookupAndRespondData>>();

    await openAISummaryLookupAndRespond(request);

    return c.json<TaskResponse>({ success: true }, 200);
};

export type UpdateTokenStatsMessageData = {
    jobGuid?: string;
};

export const handleOpenAIUpdateTokenStatsJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<UpdateTokenStatsMessageData | undefined>>();

    await updateTokenStatsMessage(request);

    return c.json<TaskResponse>({ success: true }, 200);
};
