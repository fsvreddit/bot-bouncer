import { context } from "@devvit/web/server";
import { OnCommentUpdateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { CONTROL_SUBREDDIT, handleClientCommentUpdate } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";

export const onCommentUpdate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnCommentUpdateRequest>();

    if (!event.comment?.id) {
        return c.json<TriggerResponse>({ message: "CommentUpdate event missing comment ID" }, 400);
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        return c.json<TriggerResponse>({ message: "CommentUpdate event should not be handled for the control subreddit" }, 400);
    }

    if (await hasEventBeenHandled(`CommentUpdate:${event.comment.id}`)) {
        return c.json<TriggerResponse>({ message: "CommentUpdate event already handled" }, 200);
    }

    await handleClientCommentUpdate(event);

    return c.json<TriggerResponse>({ message: "CommentUpdate event handled successfully" }, 200);
};
