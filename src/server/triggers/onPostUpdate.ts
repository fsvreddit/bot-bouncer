import { context } from "@devvit/web/server";
import { OnPostUpdateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { CONTROL_SUBREDDIT, handleClientPostUpdate } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";

export const onPostUpdate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnPostUpdateRequest>();

    if (!event.post?.id) {
        return c.json<TriggerResponse>({ message: "PostUpdate event missing post ID" }, 400);
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        return c.json<TriggerResponse>({ message: "PostUpdate event should not be handled for the control subreddit" }, 200);
    }

    if (await hasEventBeenHandled(`PostUpdate:${event.post.id}`)) {
        return c.json<TriggerResponse>({ message: "PostUpdate event already handled" }, 200);
    }

    await handleClientPostUpdate(event);

    return c.json<TriggerResponse>({ message: "PostUpdate event handled successfully" }, 200);
};
