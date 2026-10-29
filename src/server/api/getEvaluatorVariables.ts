import { Context } from "hono";
import { getEvaluatorVariables } from "../core/userEvaluation";

export const handleGetEvaluatorVariables = async (c: Context): Promise<Response> => {
    if (c.req.method !== "GET") {
        return c.json({ error: "Method not allowed" }, 405);
    }

    const evaluatorVariables = await getEvaluatorVariables();

    return c.json(evaluatorVariables, 200);
};
