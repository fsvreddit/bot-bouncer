import { TriggerContext } from "@devvit/public-api";
import { PostFlairUpdate } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { getUsernameFromUrl } from "./utility.js";
import json2md from "json2md";

export async function handleControlSubFlairUpdate (event: PostFlairUpdate, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (!event.author?.name || !event.post) {
        return;
    }

    const appUser = await context.reddit.getAppUser();

    if (event.post.authorId !== appUser.id) {
        return;
    }

    const postFlair = event.post.linkFlair?.text as UserStatus | undefined;
    if (!postFlair) {
        return;
    }

    const ignoreCheck = await context.redis.exists(`ignoreflairchange:${event.post.id}`);
    if (ignoreCheck) {
        return;
    }

    const username = getUsernameFromUrl(event.post.url);
    if (!username) {
        return;
    }

    if (!Object.values(UserStatus).includes(postFlair)) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);

    await setUserStatus(username, {
        trackingPostId: event.post.id,
        userStatus: postFlair,
        submitter: currentStatus?.submitter,
        lastUpdate: new Date().getTime(),
        operator: event.author.name,
    }, context);

    console.log(`Flair Update: Status for ${username} set to ${postFlair} by ${event.author.name}`);

    const post = await context.reddit.getPostById(event.post.id);

    // Look for Account Properties comment and delete it.
    if (postFlair !== UserStatus.Pending) {
        const comment = await post.comments.all();
        const commentToDelete = comment.find(c => c.authorName === context.appName && c.body.startsWith("## Account Properties"));

        if (commentToDelete) {
            await commentToDelete.delete();
        }

        if (post.numberOfReports > 0) {
            await context.reddit.approve(event.post.id);
        }
    }

    if (currentStatus?.userStatus === UserStatus.Pending && currentStatus.submitter && postFlair !== UserStatus.Pending) {
        const shouldSendFeedback = await context.redis.exists(`sendFeedback:${username}`);
        if (shouldSendFeedback) {
            await sendFeedback(username, currentStatus.submitter, event.author.name, postFlair, context);
        }
    }
}

async function sendFeedback (username: string, submitter: string, operator: string, userStatus: UserStatus, context: TriggerContext) {
    const statusToExplanation: Record<UserStatus, string> = {
        [UserStatus.Organic]: "is likely to be a human run account rather than a bot.",
        [UserStatus.Banned]: "has been classified as a bot and will be banned from any subreddit using Bot Bouncer.",
        [UserStatus.Declined]: "is potentially problematic, but there is not enough information to definitively classify it as a bot.",
        [UserStatus.Service]: "is considered a bot, but performs a useful function such as moderation or is invoked explicitly by users, so will not be banned automatically.",
        [UserStatus.Retired]: "was deleted, suspended or shadowbanned before it could be classified by a human moderator.",
        [UserStatus.Purged]: "was deleted, suspended or shadowbanned after it was classified as a bot.",
        [UserStatus.Inactive]: "has no recent activity and so has not been classified explicitly.",
        [UserStatus.Pending]: "is still being evaluated and has not been classified yet.",
    };

    const automaticText = operator === context.appName ? "automatically" : "manually";
    const message: json2md.DataObject[] = [
        { p: `Hi ${submitter}, you recently submitted /u/${username} to /r/${CONTROL_SUBREDDIT}.` },
        { p: `The bot has been classified ${automaticText} as **${userStatus}**.` },
    ];

    if (userStatus in statusToExplanation) {
        message.push({ p: `This means that the account ${statusToExplanation[userStatus]}` });
    }

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
    } catch (error) {
        console.error(`Failed to send feedback to ${submitter}: ${error}`);
        return;
    }

    await context.redis.del(`sendFeedback:${username}`);

    console.log(`Feedback sent to ${submitter} about ${username} being classified as ${userStatus} by ${operator}`);
}
