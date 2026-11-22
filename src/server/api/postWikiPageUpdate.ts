import { reddit, UpdateWikiPageOptions } from "@devvit/web/server";
import { Context } from "hono";

export const handlePostWikiPageUpdate = async (c: Context): Promise<Response> => {
    const request = await c.req.json<UpdateWikiPageOptions>();

    await reddit.updateWikiPage(request);
    console.log(`Updated wiki page ${request.page} via external endpoint`);

    return c.json({ success: true }, 200);
};
