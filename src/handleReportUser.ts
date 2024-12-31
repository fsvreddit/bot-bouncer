import { Context, MenuItemOnPressEvent, Post, Comment, JSONObject, FormOnSubmitEvent } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, EVALUATE_USER } from "./constants.js";
import { getPostOrCommentById, getUsernameFromUrl, getUserOrUndefined } from "./utility.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { addExternalSubmission } from "./externalSubmissions.js";
import { reportForm } from "./main.js";
import { subMonths } from "date-fns";
import { getControlSubSettings } from "./settings.js";

export async function handleReportUser (event: MenuItemOnPressEvent, context: Context) {
    const target = await getPostOrCommentById(event.targetId, context);
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubReportUser(target, context);
    } else {
        const currentStatus = await getUserStatus(target.authorName, context);
        if (currentStatus) {
            context.ui.showToast(`${target.authorName} has already been reported to Bot Bouncer.`);
            return;
        }

        const [controlSubSettings, currentUser] = await Promise.all([
            getControlSubSettings(context),
            context.reddit.getCurrentUser(),
        ]);

        if (!currentUser) {
            context.ui.showToast("You must be logged in to report users to Bot Bouncer.");
            return;
        }

        if (controlSubSettings.reporterBlacklist.includes(currentUser.username)) {
            context.ui.showToast("You are not currently permitted to submit bots to r/BotBouncer. Please write in to modmail if you believe this is a mistake");
            return;
        }

        context.ui.showForm(reportForm);
    }
}

export async function reportFormHandler (event: FormOnSubmitEvent<JSONObject>, context: Context) {
    const targetId = context.commentId ?? context.postId;
    if (!targetId) {
        context.ui.showToast("Sorry, could not report user.");
        console.log("Error handling report form", context);
        return;
    }

    const target = await getPostOrCommentById(targetId, context);

    const user = await getUserOrUndefined(target.authorName, context);

    if (!user) {
        context.ui.showToast(`${target.authorName} appears to be shadowbanned or suspended.`);
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);

    const userContent = await context.reddit.getCommentsAndPostsByUser({
        username: target.authorName,
        limit: 100,
        sort: "new",
    }).all();

    if (userContent.filter(item => item.createdAt > subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3)).length === 0) {
        context.ui.showToast("You can only report users with recent content on their history.");
        return;
    }

    const currentUser = await context.reddit.getCurrentUser();
    const reportContext = event.values.reportContext as string | undefined;
    await addExternalSubmission({
        username: target.authorName,
        submitter: currentUser?.username,
        reportContext,
        targetId: target.id,
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
        let message = `${username}'s current status is ${currentStatus.userStatus}`;
        if (currentStatus.submitter) {
            message += `, reported by ${currentStatus.submitter}.`;
        } else {
            message += ".";
        }
        context.ui.showToast(message);
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
