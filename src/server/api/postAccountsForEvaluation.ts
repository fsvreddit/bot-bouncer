import { Context } from "hono";
import { queueKarmaFarmingAccounts } from "../core/controlSubCore";

export const handlePostAccountsForEvaluation = async (c: Context): Promise<Response> => {
    const request = await c.req.json<string[]>();

    if (request.length === 0) {
        return c.json({ success: false, error: "No accounts provided" }, 400);
    }

    await queueKarmaFarmingAccounts(request);

    return c.json({ success: true }, 200);
};
