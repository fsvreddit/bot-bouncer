import { Context } from "hono";
import { getEvaluatorVariables } from "../core/userEvaluation";

export const handleGetEvaluatorVariables = async (c: Context): Promise<Response> => {
    const evaluatorVariables = await getEvaluatorVariables();

    return c.json(evaluatorVariables, 200);
};
