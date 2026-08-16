import { TriggerContext } from "@devvit/public-api";
import { getUserStatus } from "./dataStore.js";
import json2md from "json2md";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { addMinutes } from "date-fns";
import { UserStatus } from "./types.js";

const FEEDBACK_QUEUE = "FeedbackQueue";

const statusToExplanation: Record<UserStatus, string> = {
    [UserStatus.Organic]: "seems likely to be a human run account rather than a bot.",
    [UserStatus.Banned]: "has been classified as a bot and will be banned from any subreddit using Bot Bouncer if they post or comment there.",
    [UserStatus.Service]: "is considered a bot, but performs a useful function such as moderation or is invoked explicitly by users, so will not be banned automatically.",
    [UserStatus.Retired]: "was deleted, suspended or shadowbanned before it could be classified by a human moderator.",
    [UserStatus.Purged]: "was deleted, suspended or shadowbanned after it was classified as a bot.",
    [UserStatus.Inactive]: "has no recent activity and so has not been classified explicitly.",
    [UserStatus.Pending]: "is still being evaluated and has not been classified yet.",
};

export async function queueSendFeedback (username: string, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("queueSendFeedback can only be run in the control subreddit context");
    }

    const feedbackRequested = await context.redis.exists(`sendFeedback:${username}`, `callbackCommentPosted:${username}`);
    if (!feedbackRequested) {
        return;
    }

    if (await context.redis.zScore(FEEDBACK_QUEUE, username)) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus?.submitter) {
        console.log(`No submitter found for ${username}, not queuing feedback.`);
        return;
    }

    await context.redis.zAdd(FEEDBACK_QUEUE, { member: username, score: addMinutes(new Date(), 2).getTime() });
}

export async function processFeedbackQueue (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("processFeedbackQueue can only be run in the control subreddit context");
    }

    const pendingFeedback = await context.redis.zRange(FEEDBACK_QUEUE, 0, Date.now(), { by: "score" });

    if (pendingFeedback.length === 0) {
        return;
    }

    const firstUser = pendingFeedback[0].member;
    const currentStatus = await getUserStatus(firstUser, context);
    if (!currentStatus?.submitter) {
        console.log(`No submitter found for ${firstUser}, skipping feedback.`);
        await context.redis.zRem(FEEDBACK_QUEUE, [firstUser]);
        return;
    }

    await context.redis.zRem(FEEDBACK_QUEUE, [firstUser]);

    if (await context.redis.exists(`sendFeedback:${firstUser}`)) {
        await sendFeedbackViaModmail(firstUser, currentStatus.submitter, currentStatus.operator, currentStatus.userStatus, context);
    } else {
        const commentId = await context.redis.get(`callbackCommentPosted:${firstUser}`);
        if (commentId) {
            await updateCommentWithFeedback(firstUser, commentId, currentStatus.userStatus, context);
        }
    }

    if (pendingFeedback.length > 1) {
        console.log(`Processed feedback for ${firstUser}, ${pendingFeedback.length - 1} remaining.`);
    }
}

async function sendFeedbackViaModmail (username: string, submitter: string, operator: string | undefined, userStatus: UserStatus, context: TriggerContext) {
    const modmailKeyForUser = `feedbackModmailConversation:${username}`;
    const existingModmailId = await context.redis.get(modmailKeyForUser);

    const automaticText = operator === context.appSlug ? "automatically" : "manually";
    const message: json2md.DataObject[] = [
        { p: `Hi ${submitter}, you recently reported /u/${username} to /r/${CONTROL_SUBREDDIT}.` },
    ];

    let nextLine = `The account has been classified ${automaticText} as **${userStatus}**.`;
    if (userStatus in statusToExplanation) {
        nextLine += ` This means that the account ${statusToExplanation[userStatus]}`;
    }

    message.push({ p: nextLine });

    message.push({ p: "This status may change in the future if we receive more information or if the user questions their classification." });

    if (userStatus === UserStatus.Organic || userStatus === UserStatus.Service) {
        message.push({ p: `If you have any more information to help us understand why this may be a harmful or disruptive bot, please reply to this message.` });
    }

    try {
        if (existingModmailId) {
            const conversation = await context.reddit.modMail.getConversation({ conversationId: existingModmailId });
            await context.reddit.modMail.reply({
                conversationId: existingModmailId,
                body: json2md(message),
            });
            if (conversation.conversation?.state?.toLowerCase() === "archived") {
                await context.reddit.modMail.archiveConversation(existingModmailId);
            }
        } else {
            const newModmailConversation = await context.reddit.modMail.createConversation({
                subredditName: CONTROL_SUBREDDIT,
                subject: "Bot Bouncer classification feedback",
                body: json2md(message),
                to: submitter,
            });
            if (newModmailConversation.conversation.id) {
                await context.redis.set(modmailKeyForUser, newModmailConversation.conversation.id);
                await context.reddit.modMail.archiveConversation(newModmailConversation.conversation.id);
            }
        }

        console.log(`Feedback sent to ${submitter} about ${username} being classified as ${userStatus} by ${operator}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to send feedback to ${submitter} about ${username} being classified as ${userStatus} by ${operator}: ${message}`);
        if (existingModmailId) {
            // Might have hit a limit on the conversation, so clear existing key to create a new one next time.
            await context.redis.del(modmailKeyForUser);
        }
    }

    await context.redis.del(`sendFeedback:${username}`);
}

async function updateCommentWithFeedback (username: string, commentId: string, userStatus: UserStatus, context: TriggerContext) {
    const comment = await context.reddit.getCommentById(commentId);
    if (comment.authorName !== context.appSlug) {
        console.warn(`Comment ${commentId} has been deleted, cannot update with feedback.`);
        return;
    }

    let commentText = comment.body;
    commentText += `\n\nEdit: This account has now been classified as **${userStatus}**. This means that the account ${statusToExplanation[userStatus]}`;
    if (userStatus === UserStatus.Organic || userStatus === UserStatus.Service) {
        commentText += `\n\nIf you have any more information to help us understand why this may be a harmful or disruptive bot, please [message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=More%20information%20about%20${username})`;
    }

    await comment.edit({ text: commentText });

    console.log(`Updated comment ${commentId} with feedback about ${username} being classified as ${userStatus}`);
    await context.redis.del(`callbackCommentPosted:${username}`);
}
