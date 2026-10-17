import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT } from "../core";
import { updateEvaluatorVariablesFromWikiHandler } from "../core/userEvaluation";

export type UpdateEvaluatorVariablesFromWikiEventData = {
    jobGuid?: string;
    username?: string;
    actionedAt?: number;
    updateExtraVariables?: boolean;
};

export const handleEvaluatorVariableUpdateFromWikiJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Evaluator Variables: handleEvaluatorVariableUpdateFromWikiJob should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<UpdateEvaluatorVariablesFromWikiEventData>>();

    await updateEvaluatorVariablesFromWikiHandler(request);

    return c.json<TaskResponse>({ message: "Evaluator variables updated" }, 200);
};
