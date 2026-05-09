import { PostDelete } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import pluralize from "pluralize";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

export async function handleControlSubPostDelete (event: PostDelete, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    if (event.source as number !== 1) {
        // Not deleted by user.
        return;
    }

    if (await hasTriggerBeenHandled(context.redis, `PostDelete:${event.postId}:${event.deletedAt?.getTime()}`)) {
        return;
    }

    const post = await context.reddit.getPostById(event.postId);
    const comments = await post.comments.all();

    const appComments = comments.filter(comment => comment.authorName === context.appSlug);
    if (appComments.length === 0) {
        return;
    }

    await Promise.all(appComments.map(comment => comment.delete()));
    console.log(`Deleted ${appComments.length} ${pluralize("comment", appComments.length)} from deleted post ${event.postId}`);
}
