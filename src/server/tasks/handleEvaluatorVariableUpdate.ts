import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { CONTROL_SUBREDDIT } from "../core";
import { updateEvaluatorVariables } from "../core/userEvaluation";

export type UpdateEvaluatorVariablesEventData = {
    jobGuid: string;
    updateExtraVariables?: boolean;
};

export const handleEvaluatorVariableUpdateJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Evaluator Variables: handleEvaluatorVariableUpdateJob should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<UpdateEvaluatorVariablesEventData>>();

    await updateEvaluatorVariables(request);

    return c.json<TaskResponse>({ message: "Evaluator variables updated" }, 200);
};
