import { reddit, TaskRequest, UpdateWikiPageOptions, TaskResponse } from "@devvit/web/server";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addMinutes, differenceInSeconds } from "date-fns";
import { Context } from "hono";

export type AsyncWikiUpdateJobData = UpdateWikiPageOptions & {
    jobGuid: string;
};

export const handleAsyncWikiUpdateJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<AsyncWikiUpdateJobData>>();

    if (await hasEventBeenHandled(`job:${request.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Async Wiki Update Job: Job with guid ${request.data.jobGuid} has already been handled, skipping.`);
        return c.json<TaskResponse>({
            success: false,
        }, 200);
    }

    const now = Date.now();

    if (request.data.content.length > 512 * 1024) {
        console.error(`Wiki page content exceeds 512 KB: ${request.data.page}, truncating`);
        request.data.content = `**WARNING: TRUNCATED DATA**\n\n${request.data.content}`.slice(0, (512 * 1024) - 1);
    }

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
