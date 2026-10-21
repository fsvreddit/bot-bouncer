import { context } from "@devvit/web/server";
import { OnCommentCreateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { CONTROL_SUBREDDIT, handleClientCommentCreate, handleControlSubCommentCreate } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";

export const onCommentCreate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnCommentCreateRequest>();

    if (!event.comment?.id) {
        return c.json<TriggerResponse>({ message: "CommentCreate event missing comment ID" }, 400);
    }

    if (await hasEventBeenHandled(`CommentCreate:${event.comment.id}`)) {
        return c.json<TriggerResponse>({ message: "CommentCreate event already handled" }, 200);
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubCommentCreate(event);
    } else {
        await handleClientCommentCreate(event);
    }

    return c.json<TriggerResponse>({ message: "CommentCreate event handled successfully" }, 200);
};
