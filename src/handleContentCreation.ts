import { CommentCreate, PostCreate } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { handleControlSubCommentCreate } from "./handleControlSubComment.js";
import { handleClientCommentCreate, handleClientPostCreate } from "./handleClientPostOrComment.js";
import { handleControlSubPostCreate } from "./handleControlSubSubmission.js";
import { ensureClientSubJobsExist } from "./installActions.js";
import { recordUserContentCreation } from "./handleClientSubredditClassificationChanges.js";

export async function handleCommentCreate (event: CommentCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubCommentCreate(event, context);
    } else {
        if (event.author?.name) {
            await recordUserContentCreation(event.author.name, context);
        }
        await handleClientCommentCreate(event, context);
    }
}

export async function handlePostCreate (event: PostCreate, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubPostCreate(event, context);
    } else {
        if (event.author?.name) {
            await recordUserContentCreation(event.author.name, context);
        }
        await handleClientPostCreate(event, context);
        await ensureClientSubJobsExist(context);
    }
}
