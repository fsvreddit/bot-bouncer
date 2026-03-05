import { PostDelete } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import pluralize from "pluralize";

export async function handleControlSubPostDelete (event: PostDelete, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (event.source as number !== 1) {
        // Not deleted by user.
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
