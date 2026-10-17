import { context, reddit } from "@devvit/web/server";
import type { OnPostDeleteRequest, T3, TriggerResponse } from "@devvit/web/shared";
import type { Context } from "hono";
import { CONTROL_SUBREDDIT } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import pluralize from "pluralize";

export const onPostDelete = async (c: Context): Promise<Response> => {
    const request = await c.req.json<OnPostDeleteRequest>();
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return c.json<TriggerResponse>({ message: "Wrong subreddit" }, 200);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    if (request.source as number !== 1) {
        // Not deleted by user.
        return c.json<TriggerResponse>({ message: "Not deleted by user" }, 200);
    }

    if (await hasEventBeenHandled(`PostDelete:${request.postId}:${request.deletedAt}`)) {
        return c.json<TriggerResponse>({ message: "Trigger already handled" }, 200);
    }

    const post = await reddit.getPostById(request.postId as T3);
    const comments = await post.comments.all();

    const appComments = comments.filter(comment => comment.authorName === context.appSlug);
    if (appComments.length === 0) {
        return c.json<TriggerResponse>({ message: "No comments to delete" }, 200);
    }

    await Promise.all(appComments.map(comment => comment.delete()));
    console.log(`Deleted ${appComments.length} ${pluralize("comment", appComments.length)} from deleted post ${request.postId}`);

    return c.json<TriggerResponse>({ message: "Deleted comments successfully" }, 200);
};
