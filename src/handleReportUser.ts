import { Context, MenuItemOnPressEvent, JSONObject, FormOnSubmitEvent, Form } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getPostOrCommentById, getUserOrUndefined, isModerator } from "./utility.js";
import { getUserStatus } from "./dataStore.js";
import { addExternalSubmissionFromClientSub } from "./externalSubmissions.js";
import { reportForm } from "./main.js";
import { subMonths } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import { handleControlSubReportUser } from "./handleControlSubMenu.js";
import { recordReportForDigest } from "./modmail/dailyDigest.js";

enum ReportFormField {
    ReportContext = "reportContext",
    PublicContext = "publicContext",
    SendFeedback = "sendFeedback",
}

export const reportFormDefinition: Form = {
    fields: [
        {
            type: "paragraph",
            label: "Optional. Please provide more information that might help us understand why this is a bot",
            helpText: "This is in case it is not obvious that this is a bot",
            lineHeight: 4,
            name: ReportFormField.ReportContext,
        },
        {
            type: "boolean",
            label: "Show the above text publicly on the post on r/BotBouncer",
            helpText: "Your username will be kept private",
            defaultValue: true,
            name: ReportFormField.PublicContext,
        },
        {
            type: "boolean",
            label: "Receive a notification when this account is classified",
            helpText: "You must be able to receive chat messages from /u/bot-bouncer to receive this notification",
            defaultValue: false,
            name: ReportFormField.SendFeedback,
        },
    ],
};

export async function handleReportUser (event: MenuItemOnPressEvent, context: Context) {
    const target = await getPostOrCommentById(event.targetId, context);
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubReportUser(target, context);
        return;
    }

    const currentStatus = await getUserStatus(target.authorName, context);
    if (currentStatus) {
        context.ui.showToast(`${target.authorName} has already been reported to Bot Bouncer with status: ${currentStatus.userStatus}`);
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

    if (target.authorName === `${context.subredditName}-ModTeam}`) {
        context.ui.showToast("You cannot report the subreddit's -ModTeam user.");
        return;
    }

    if (target.authorName === currentUser.username) {
        context.ui.showToast("You cannot report yourself.");
        return;
    }

    if (await isModerator(target.authorName, context)) {
        context.ui.showToast("You cannot report a moderator of this subreddit.");
        return;
    }

    context.ui.showForm(reportForm);
}

export async function reportFormHandler (event: FormOnSubmitEvent<JSONObject>, context: Context) {
    const targetId = context.commentId ?? context.postId;
    const publicContext = event.values[ReportFormField.PublicContext] as boolean | undefined ?? true;
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
    const reportContext = event.values[ReportFormField.ReportContext] as string | undefined;

    await Promise.all([
        addExternalSubmissionFromClientSub({
            username: target.authorName,
            submitter: currentUser?.username,
            reportContext,
            publicContext,
            targetId: target.id,
            sendFeedback: event.values[ReportFormField.SendFeedback] as boolean | undefined,
        }, "manual", context),
        recordReportForDigest(target.authorName, "manually", context.redis),
    ]);

    context.ui.showToast(`${target.authorName} has been submitted to /r/${CONTROL_SUBREDDIT}. A tracking post will be created shortly.`);
}
