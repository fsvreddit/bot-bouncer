import { reddit, TaskRequest, UpdateWikiPageOptions, TaskResponse } from "@devvit/web/server";
import { differenceInSeconds } from "date-fns";
import { Context } from "hono";

export const handleAsyncWikiUpdateJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<UpdateWikiPageOptions>>();

    const now = Date.now();

    try {
        await reddit.updateWikiPage(request.data);
    } catch (error) {
        console.error(`Failed to update wiki page after ${differenceInSeconds(new Date(), now)} seconds: ${request.data.page}`, error);
    }
    console.log(`Updated wiki page: ${request.data.page}`);

    return c.json<TaskResponse>({
        success: true,
    }, 200);
};
