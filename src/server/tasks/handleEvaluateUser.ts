import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { handleControlSubAccountEvaluation } from "../core";

export type EvaluateUserJobData = {
    username: string;
    postId: T3;
    forceManualReview: boolean;
    forceManualReviewReasons?: string[];
    skipSummary?: boolean;
    jobGuid: string;
};

export const handleEvaluateUserJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<EvaluateUserJobData>>();

    await handleControlSubAccountEvaluation(request);
    return c.json<TaskResponse>({ success: true }, 200);
};
