import { TriggerContext } from "@devvit/public-api";
import { PostDelete } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { deleteUserStatus, getUsernameFromPostId } from "./dataStore.js";

export async function handleControlSubPostDelete (event: PostDelete, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const username = await getUsernameFromPostId(event.postId, context);
    if (!username) {
        // Not a submission from this app.
        return;
    }

    const post = await context.reddit.getPostById(event.postId);
    await deleteUserStatus([username], context);
    if (post.authorName === context.appName) {
        await post.delete();
    }

    console.log(`Post ${event.postId} deleted or removed. All records for this post have been removed and the post has been deleted.`);
}
