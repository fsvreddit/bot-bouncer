import { CommentCreate, PostCreate } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { handleControlSubCommentCreate } from "./handleControlSubComment.js";
import { handleClientCommentCreate, handleClientPostCreate } from "./handleClientPostOrComment.js";
import { handleControlSubPostCreate } from "./handleControlSubSubmission.js";
import { ensureClientSubJobsExist } from "./installActions.js";
import { hasTriggerBeenHandled } from "./utility.js";

export async function handleCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (!event.comment?.id) {
        return;
    }

    if (await hasTriggerBeenHandled(`CommentCreate:${event.comment.id}`, context)) {
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
        return;
    }

    if (await hasTriggerBeenHandled(`PostCreate:${event.post.id}`, context)) {
        return;
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubPostCreate(event, context);
    } else {
        await handleClientPostCreate(event, context);
        await ensureClientSubJobsExist(context);
    }
}
