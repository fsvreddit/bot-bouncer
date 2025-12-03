import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "./dataStore.js";
import json2md from "json2md";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { addMinutes, subDays } from "date-fns";

const FEEDBACK_QUEUE = "FeedbackQueue";
const FAILED_FEEDBACK_STORE = "FailedFeedbackStore";
const FAILED_FEEDBACK_WIKI_PAGE = "failed-feedback-users";

interface FailedFeedbackItem {
    firstFailed: number;
    countFailed: number;
}

export async function queueSendFeedback (username: string, context: TriggerContext) {
    const feedbackRequested = await context.redis.exists(`sendFeedback:${username}`);
    if (!feedbackRequested) {
        return;
    }

    if (await context.redis.zScore(FEEDBACK_QUEUE, username)) {
        return;
    }

    const failedFeedbackItem = await context.redis.global.hGet(FAILED_FEEDBACK_STORE, username);
    if (failedFeedbackItem) {
        const parsedItem = JSON.parse(failedFeedbackItem) as FailedFeedbackItem;
        if (parsedItem.countFailed >= 5) {
            console.log(`Not sending feedback to ${username} as there have been ${parsedItem.countFailed} previous failures`);
            return;
        }
    }

    await context.redis.zAdd(FEEDBACK_QUEUE, { member: username, score: addMinutes(new Date(), 2).getTime() });
}

export async function processFeedbackQueue (context: TriggerContext) {
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
    await sendFeedback(firstUser, currentStatus.submitter, currentStatus.operator, currentStatus.userStatus, context);

    if (pendingFeedback.length > 1) {
        console.log(`Processed feedback for ${firstUser}, ${pendingFeedback.length - 1} remaining.`);
    }
}

async function sendFeedback (username: string, submitter: string, operator: string | undefined, userStatus: UserStatus, context: TriggerContext) {
    const statusToExplanation: Record<UserStatus, string> = {
        [UserStatus.Organic]: "seems likely to be a human run account rather than a bot.",
        [UserStatus.Banned]: "has been classified as a bot and will be banned from any subreddit using Bot Bouncer if they post or comment there.",
        [UserStatus.Declined]: "is potentially problematic, but there is not enough information to definitively classify it as a bot at this time.",
        [UserStatus.Service]: "is considered a bot, but performs a useful function such as moderation or is invoked explicitly by users, so will not be banned automatically.",
        [UserStatus.Retired]: "was deleted, suspended or shadowbanned before it could be classified by a human moderator.",
        [UserStatus.Purged]: "was deleted, suspended or shadowbanned after it was classified as a bot.",
        [UserStatus.Inactive]: "has no recent activity and so has not been classified explicitly.",
        [UserStatus.Pending]: "is still being evaluated and has not been classified yet.",
    };

    const automaticText = operator === context.appName ? "automatically" : "manually";
    const message: json2md.DataObject[] = [
        { p: `Hi ${submitter}, you recently reported /u/${username} to /r/${CONTROL_SUBREDDIT}.` },
    ];

    let nextLine = `The account has been classified ${automaticText} as **${userStatus}**.`;
    if (userStatus in statusToExplanation) {
        nextLine += ` This means that the account ${statusToExplanation[userStatus]}`;
    }

    message.push({ p: nextLine });

    message.push({ p: "This status may change in the future if we receive more information or if the user questions their classification." });

    if (userStatus === UserStatus.Organic || userStatus === UserStatus.Declined || userStatus === UserStatus.Service) {
        message.push({ p: `If you have any more information to help us understand why this may be a harmful or disruptive bot, please [message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=More%20information%20about%20/u/${username})` });
    }

    message.push({ p: "*Please do not reply to this message, replies will not be read. If you have any questions please contact /r/BotBouncer by modmail*" });

    try {
        await context.reddit.sendPrivateMessage({
            to: submitter,
            subject: `Bot Bouncer classification for /u/${username}`,
            text: json2md(message),
        });

        console.log(`Feedback sent to ${submitter} about ${username} being classified as ${userStatus} by ${operator}`);
    } catch (error) {
        const existingFailedItem = await context.redis.global.hGet(FAILED_FEEDBACK_STORE, submitter);
        let itemToStore: FailedFeedbackItem;
        if (existingFailedItem) {
            itemToStore = JSON.parse(existingFailedItem) as FailedFeedbackItem;
            itemToStore.countFailed++;
        } else {
            itemToStore = { firstFailed: Date.now(), countFailed: 1 };
        }

        console.error(`Failed to send feedback to ${submitter}. Total failed now: ${itemToStore.countFailed}: ${error}`);

        await context.redis.global.hSet(FAILED_FEEDBACK_STORE, { [submitter]: JSON.stringify(itemToStore) });

        if (itemToStore.countFailed >= 3) {
            await updateFailedFeedbackStorage(context);
        }
    }

    await context.redis.del(`sendFeedback:${username}`);
}

export async function updateFailedFeedbackStorage (context: TriggerContext) {
    const failedFeedbackDataRaw = await context.redis.global.hGetAll(FAILED_FEEDBACK_STORE);
    const itemsToRemoveFromStore: string[] = [];
    const itemsToExcludeFromPage: string[] = [];

    for (const [username, data] of Object.entries(failedFeedbackDataRaw)) {
        const parsedData = JSON.parse(data) as FailedFeedbackItem;
        if (parsedData.firstFailed < subDays(new Date(), 1).getTime()) {
            itemsToRemoveFromStore.push(username);
        }

        if (parsedData.countFailed < 3) {
            itemsToExcludeFromPage.push(username);
        }
    }

    if (itemsToRemoveFromStore.length > 0) {
        await context.redis.global.hDel(FAILED_FEEDBACK_STORE, itemsToRemoveFromStore);
    }

    const usernamesWithFailedFeedback = Object.keys(failedFeedbackDataRaw)
        .filter(username => !itemsToRemoveFromStore.includes(username) && !itemsToExcludeFromPage.includes(username));

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: FAILED_FEEDBACK_WIKI_PAGE,
        content: JSON.stringify(usernamesWithFailedFeedback),
    });
}

export async function canUserReceiveFeedback (username: string, context: TriggerContext): Promise<boolean> {
    const userCanReceiveFeedback = await context.redis.global.hGet(FAILED_FEEDBACK_STORE, username)
        .then(item => item === undefined);

    return userCanReceiveFeedback;
}
