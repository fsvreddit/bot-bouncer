import { TriggerContext } from "@devvit/public-api";
import { CommentDelete, PostDelete } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus } from "./dataStore.js";
import { addExternalSubmissionFromClientSub } from "./externalSubmissions.js";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";

export async function handleClientSubPostDelete (event: PostDelete, context: TriggerContext) {
    await handleClientSubContentDelete(event, event.postId, context);
}

export async function handleClientSubCommentDelete (event: CommentDelete, context: TriggerContext) {
    await handleClientSubContentDelete(event, event.commentId, context);
}

async function handleClientSubContentDelete (event: PostDelete | CommentDelete, thingId: string, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    if (event.source as number !== 1) {
        // Not deleted by user.
        return;
    }

    const botMentionForUser = await context.redis.get(`botmention:${thingId}`);
    if (!botMentionForUser) {
        return;
    }

    // Post or comment has been deleted within two minutes of a "bot" mention. Create external submission.
    const currentStatus = await getUserStatus(botMentionForUser, context);
    if (currentStatus) {
        return;
    }

    const variables = await getEvaluatorVariables(context);
    if (variables["botmentions:killswitch"]) {
        return;
    }

    await addExternalSubmissionFromClientSub({
        username: botMentionForUser,
        submitter: context.appName,
        reportContext: "User reported due to deleting a post or comment immediately after a 'Bot' accusation",
        targetId: thingId,
    }, "automatic", context);

    console.log(`External submission created for ${botMentionForUser} due to bot accusation`);
}
