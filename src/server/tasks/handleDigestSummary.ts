import type { Context } from "hono";
import { TaskResponse } from "@devvit/web/server";
import { sendDigestSummary } from "../core";

export const handleDigestSummaryJob = async (c: Context): Promise<Response> => {
    await sendDigestSummary();

    return c.json<TaskResponse>({ success: true }, 200);
};
