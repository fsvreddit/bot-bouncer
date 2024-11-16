import { Context, MenuItemOnPressEvent, Post, Comment, User } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER } from "./constants.js";
import { getPostOrCommentById, getUsernameFromUrl, getUserOrUndefined } from "./utility.js";
import { getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { addExternalSubmission } from "./externalSubmissions.js";

export async function handleReportUser (event: MenuItemOnPressEvent, context: Context) {
    const target = await getPostOrCommentById(event.targetId, context);

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubReportUser(target, context);
    } else {
        await handleClientSubReportUser(target, context);
    }
}

async function handleClientSubReportUser (target: Post | Comment, context: Context) {
    const currentStatus = await getUserStatus(target.authorName, context);
    if (currentStatus) {
        context.ui.showToast(`${target.authorName} has already been reported to Bot Bouncer.`);
        return;
    }

    const user = await getUserOrUndefined(target.authorName, context);

    if (!user) {
        context.ui.showToast(`${target.authorName} appears to be shadowbanned or suspended.`);
        return;
    }

    await addExternalSubmission(target.authorName, context);

    // Set local status
    await setUserStatus(target.authorName, {
        userStatus: UserStatus.Pending,
        lastUpdate: new Date().getTime(),
        operator: context.appName,
        trackingPostId: "",
    }, context);

    context.ui.showToast(`${target.authorName} has been submitted to /r/${CONTROL_SUBREDDIT}. A tracking post will be created shortly.`);
}

async function handleControlSubReportUser (target: Post | Comment, context: Context) {
    let username: string | undefined;
    if (target instanceof Comment) {
        username = target.authorName;
    } else {
        username = getUsernameFromUrl(target.url);
    }

    if (!username) {
        context.ui.showToast("This option cannot be used here");
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus) {
        context.ui.showToast(`${username}'s current status is ${currentStatus.userStatus}.`);
        if (currentStatus.userStatus === UserStatus.Pending) {
            await context.scheduler.runJob({
                name: EVALUATE_USER,
                runAt: new Date(),
                data: {
                    username,
                    postId: target.id,
                },
            });
            context.ui.showToast("User will be re-evaluated using AI detections");
        }
    } else {
        context.ui.showToast(`${username} is not currently known to Bot Bouncer`);
    }
}
