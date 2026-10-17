import { context } from "@devvit/web/server";
import { OnPostCreateRequest, TriggerResponse } from "@devvit/web/shared";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { Context } from "hono";
import { CONTROL_SUBREDDIT, ensureClientSubJobsExist, handleClientPostCreate, handleControlSubPostCreate } from "../core";

export const onPostCreate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnPostCreateRequest>();

    if (!event.post?.id) {
        console.error("PostCreate event missing post information", JSON.stringify(event));
        return c.json<TriggerResponse>({ message: "PostCreate event missing post information" }, 400);
    }

    if (await hasEventBeenHandled(`PostCreate:${event.post.id}`)) {
        console.log(`PostCreate event for post ${event.post.id} has already been handled, skipping.`);
        return c.json<TriggerResponse>({ message: "PostCreate event already handled" }, 200);
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubPostCreate(event);
    } else {
        await handleClientPostCreate(event);
        await ensureClientSubJobsExist();
    }

    return c.json<TriggerResponse>({ message: "PostCreate event handled successfully" }, 200);
};
