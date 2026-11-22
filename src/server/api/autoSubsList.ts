import { redis } from "@devvit/web/server";
import { Context } from "hono";

type AutoSubList = {
    postSubList: string[];
    commentSubList: string[];
};

const AUTO_SUB_LIST_KEY = "autoSubList";

export const handlePostAutoSubsList = async (c: Context): Promise<Response> => {
    const request = await c.req.json<AutoSubList>();

    await redis.set(AUTO_SUB_LIST_KEY, JSON.stringify(request));
    console.log(`Updated auto sub list via external endpoint`);

    return c.json({ success: true }, 200);
};

export const handleGetAutoSubsList = async (c: Context): Promise<Response> => {
    const autoSubList = await redis.get(AUTO_SUB_LIST_KEY);
    if (!autoSubList) {
        return c.json({ success: false, message: "Auto sub list not found" }, 404);
    }
    return c.json(JSON.parse(autoSubList), 200);
};
