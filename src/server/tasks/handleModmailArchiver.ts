import { TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { handleModmailArchiver } from "../core/controlSubCore/modmail/modmailArchiver";

export type ModmailArchiverJobData = {
    jobGuid: string;
    firstRun?: boolean;
};

export const handleModmailArchiverJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<ModmailArchiverJobData>>();

    await handleModmailArchiver(request);
    return c.json<TaskResponse>({ success: true }, 200);
};
