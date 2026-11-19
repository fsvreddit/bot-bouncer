import { Context } from "hono";
import { getEvaluatorVariables, getLastEvaluatorVariablesUpdateTimestamp } from "../core/userEvaluation";

export const handleGetEvaluatorVariables = async (c: Context): Promise<Response> => {
    const sinceValue = c.req.query("since");

    if (sinceValue) {
        const sinceTimestamp = parseInt(sinceValue);
        if (!isNaN(sinceTimestamp)) {
            const lastUpdate = await getLastEvaluatorVariablesUpdateTimestamp();
            if (lastUpdate && lastUpdate <= sinceTimestamp) {
                return c.json({ updated: false }, 200);
            }
        }
    }

    const evaluatorVariables = await getEvaluatorVariables();

    return c.json(evaluatorVariables, 200);
};
