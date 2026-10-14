import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { checkAccountsForReview } from "../core/controlSubCore/modmail";
import { Context } from "hono";

export type AccountReviewJobData = {
    jobGuid?: string;
    firstRun: boolean;
};

export const handleAccountReviewJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<AccountReviewJobData>>();

    await checkAccountsForReview(request);
    return c.json<TaskResponse>({ success: true }, 200);
};
