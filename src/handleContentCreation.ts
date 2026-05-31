import { CommentCreate, PostCreate, PostSubmit } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { handleControlSubCommentCreate } from "./handleControlSubComment.js";
import { handleClientCommentCreate, handleClientPostCreate } from "./handleClientPostOrComment.js";
import { handleControlSubPostCreate } from "./handleControlSubSubmission.js";
import { ensureClientSubJobsExist } from "./installActions.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

export async function handleCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (!event.comment?.id) {
        return;
    }

    if (await hasTriggerBeenHandled(context.redis, `CommentCreate:${event.comment.id}`)) {
        return;
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubCommentCreate(event, context);
    } else {
        await handleClientCommentCreate(event, context);
    }
}

export async function handlePostCreate (event: PostCreate, context: TriggerContext) {
    if (!event.post?.id) {
        console.error("PostCreate event missing post information", JSON.stringify(event));
        return;
    }

    if (await hasTriggerBeenHandled(context.redis, `PostCreate:${event.post.id}`)) {
        console.log(`PostCreate event for post ${event.post.id} has already been handled, skipping.`);
        return;
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubPostCreate(event, context);
    } else {
        await handleClientPostCreate(event, context);
        await ensureClientSubJobsExist(context);
    }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handlePostSubmit (event: PostSubmit, _: TriggerContext) {
    console.log(`PostSubmit: Received event for post ${event.post?.id} from ${event.author?.name}`);
}
