import { context, reddit, redis } from "@devvit/web/server";
import { T1 } from "@devvit/web/shared";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { CONTROL_SUBREDDIT, expireKeyAt, getUserStatus } from "..";
import { addMinutes, addWeeks } from "date-fns";
import json2md from "json2md";

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

export async function queueSendFeedback (username: string) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("queueSendFeedback can only be run in the control subreddit context");
    }

    const feedbackRequested = await redis.exists(`sendFeedback:${username}`, `callbackCommentPosted:${username}`);
    if (!feedbackRequested) {
        return;
    }

    if (await redis.zScore(FEEDBACK_QUEUE, username)) {
        return;
    }

    const currentStatus = await getUserStatus(username);
    if (!currentStatus?.submitter) {
        console.log(`No submitter found for ${username}, not queuing feedback.`);
        return;
    }

    await redis.zAdd(FEEDBACK_QUEUE, { member: username, score: addMinutes(new Date(), 2).getTime() });
}

export async function processFeedbackQueue () {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("processFeedbackQueue can only be run in the control subreddit context");
    }

    const pendingFeedback = await redis.zRange(FEEDBACK_QUEUE, 0, Date.now(), { by: "score" });

    if (pendingFeedback.length === 0) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstUser = pendingFeedback[0]!.member;
    const currentStatus = await getUserStatus(firstUser);
    if (!currentStatus?.submitter) {
        console.log(`No submitter found for ${firstUser}, skipping feedback.`);
        await redis.zRem(FEEDBACK_QUEUE, [firstUser]);
        return;
    }

    await redis.zRem(FEEDBACK_QUEUE, [firstUser]);

    if (await redis.exists(`sendFeedback:${firstUser}`)) {
        await sendFeedbackViaModmail(firstUser, currentStatus.submitter, currentStatus.operator, currentStatus.userStatus);
    } else {
        const commentId = await redis.get(`callbackCommentPosted:${firstUser}`);
        if (commentId) {
            await updateCommentWithFeedback(firstUser, commentId, currentStatus.userStatus);
        }
    }

    if (pendingFeedback.length > 1) {
        console.log(`Processed feedback for ${firstUser}, ${pendingFeedback.length - 1} remaining.`);
    }
}

async function sendFeedbackViaModmail (username: string, submitter: string, operator: string | undefined, userStatus: UserStatus) {
    const modmailKeyForUser = `feedbackModmailConversation:${submitter}`;
    const existingModmailId = await redis.get(modmailKeyForUser);

    const automaticText = operator === context.appSlug ? "automatically" : "manually";
    const message: json2md.DataObject[] = [
        { p: `Following your report to /r/${CONTROL_SUBREDDIT}, /u/${username} has been classified ${automaticText} as **${userStatus}**.` },
    ];

    if (userStatus === UserStatus.Organic || userStatus === UserStatus.Service) {
        message.push({ p: `If you have any more information to help us understand why this may be a harmful or disruptive bot, please reply to this message.` });
    }

    message.push({ p: "*This is an automated message, but replies will be read.*" });
    const modmailFailureKey = `modmailFailureCount:${submitter}`;

    try {
        if (existingModmailId) {
            const conversation = await reddit.modMail.getConversation({ conversationId: existingModmailId });
            await reddit.modMail.reply({
                conversationId: existingModmailId,
                body: json2md(message),
                isAuthorHidden: false,
            });
            if (conversation.conversation?.state?.toLowerCase() === "archived") {
                await reddit.modMail.archiveConversation(existingModmailId);
            } else {
                console.log(`Feedback message was sent to ${submitter} about ${username}, conversation was not archived.`);
            }
            await redis.del(modmailFailureKey);
        } else {
            const newModmailConversation = await reddit.modMail.createConversation({
                subredditName: CONTROL_SUBREDDIT,
                subject: "Bot Bouncer classification feedback",
                body: json2md(message),
                to: submitter,
                isAuthorHidden: false,
            });
            if (newModmailConversation.conversation.id) {
                await redis.set(modmailKeyForUser, newModmailConversation.conversation.id);
                await reddit.modMail.archiveConversation(newModmailConversation.conversation.id);
            } else {
                console.warn(`Feedback message was sent to ${submitter} but no conversation ID was returned.`);
            }
        }

        console.log(`Feedback sent to ${submitter} about ${username} being classified as ${userStatus} by ${operator}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to send feedback to ${submitter} about ${username} being classified as ${userStatus} by ${operator}: ${message}`);
        if (existingModmailId) {
            const failureCount = await redis.incrBy(modmailFailureKey, 1);
            if (failureCount >= 3) {
                await redis.del(modmailKeyForUser, modmailFailureKey);
            } else if (failureCount === 1) {
                await expireKeyAt(modmailFailureKey, addWeeks(new Date(), 4));
            }
        }
    }

    await redis.del(`sendFeedback:${username}`);
}

async function updateCommentWithFeedback (username: string, commentId: string, userStatus: UserStatus) {
    const comment = await reddit.getCommentById(commentId as T1);
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
    await redis.del(`callbackCommentPosted:${username}`);
}
