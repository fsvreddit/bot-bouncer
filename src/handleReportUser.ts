import { Context, MenuItemOnPressEvent, JSONObject, FormOnSubmitEvent, FormFunction, TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getPostOrCommentById, getUserOrUndefined, isModeratorWithCache } from "./utility.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { addExternalSubmissionFromClientSub } from "./externalSubmissions.js";
import { queryForm, reportForm } from "./main.js";
import { addMinutes, subMonths } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import { handleControlSubReportUser } from "./handleControlSubMenu.js";
import { recordReportForSummary } from "./modmail/actionSummary.js";
import { canUserReceiveFeedback } from "./submissionFeedback.js";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { addClassificationQueryToQueue } from "./modmail/classificationQuery.js";

enum ReportFormField {
    ReportContext = "reportContext",
    PublicContext = "publicContext",
    SendFeedback = "sendFeedback",
}

export const reportFormDefinition: FormFunction = data => ({
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
            helpText: data.feedbackHelpText as string,
            disabled: data.feedbackDisabled as boolean,
            defaultValue: false,
            name: ReportFormField.SendFeedback,
        },
    ],
});

function getAlreadyReportedKey (username: string): string {
    return `alreadyReported:${username}`;
}

async function getAlreadyReported (username: string, context: TriggerContext): Promise<boolean> {
    if (await context.redis.exists(getAlreadyReportedKey(username))) {
        return true;
    }
    return false;
}

async function setAlreadyReported (username: string, context: TriggerContext) {
    await context.redis.set(getAlreadyReportedKey(username), "", { expiration: addMinutes(new Date(), 10) });
}

export async function handleReportUser (event: MenuItemOnPressEvent, context: Context) {
    const target = await getPostOrCommentById(event.targetId, context);
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubReportUser(target, context);
        return;
    }

    const currentStatus = await getUserStatus(target.authorName, context);
    if (currentStatus) {
        const controlSubSettings = await getControlSubSettings(context);
        const queryableStatuses = [UserStatus.Organic, UserStatus.Declined, UserStatus.Service];
        if (queryableStatuses.includes(currentStatus.userStatus) && controlSubSettings.allowClassificationQueries) {
            context.ui.showForm(queryForm, { username: target.authorName, status: currentStatus.userStatus });
            return;
        } else {
            context.ui.showToast(`${target.authorName} has already been reported to Bot Bouncer with status: ${currentStatus.userStatus}`);
        }

        return;
    }

    if (await getAlreadyReported(target.authorName, context)) {
        context.ui.showToast(`${target.authorName} has already been reported recently.`);
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

    if (await isModeratorWithCache(target.authorName, context)) {
        context.ui.showToast("You cannot report a moderator of this subreddit.");
        return;
    }

    const user = await getUserOrUndefined(target.authorName, context);

    if (!user) {
        context.ui.showToast(`${target.authorName} appears to be shadowbanned or suspended.`);
        return;
    }

    const canReceiveFeedback = await canUserReceiveFeedback(currentUser.username, context);
    const data = {
        feedbackHelpText: canReceiveFeedback ? "You must be able to receive chat messages from /u/bot-bouncer to receive this notification" : "We've tried to send feedback for you several times but this hasn't worked. Check to make sure you can receive chats from /u/bot-bouncer. This option will return within 24h.",
        feedbackDisabled: !canReceiveFeedback,
    };

    context.ui.showForm(reportForm, data);
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
            subreddit: context.subredditName,
            submitter: currentUser?.username,
            reportContext,
            publicContext,
            targetId: target.id,
            sendFeedback: event.values[ReportFormField.SendFeedback] as boolean | undefined,
            immediate: true,
        }, context),
        recordReportForSummary(target.authorName, "manually", context.redis),
    ]);

    await setAlreadyReported(target.authorName, context);

    context.ui.showToast(`${target.authorName} has been submitted to /r/${CONTROL_SUBREDDIT}. A tracking post will be created shortly.`);
}

export const queryFormDefinition: FormFunction = data => ({
    title: `Query status for ${data.username}`,
    description: `This user is currently marked as ${data.status}. If you think this is a bot, please tell us why.`,
    fields: [
        {
            type: "paragraph",
            label: "Please provide more information that might help us understand why this is a bot",
            lineHeight: 6,
            name: "queryReason",
        },
    ],
});

export async function queryFormHandler (event: FormOnSubmitEvent<JSONObject>, context: Context) {
    const currentUser = await context.reddit.getCurrentUsername();
    if (!currentUser) {
        context.ui.showToast("You must be logged in to report users to Bot Bouncer.");
        return;
    }

    const targetId = context.commentId ?? context.postId;
    if (!targetId) {
        context.ui.showToast("Sorry, could not query user.");
        console.log("Error handling query form", context);
        return;
    }

    const target = isLinkId(targetId) ? await context.reddit.getPostById(targetId) : await context.reddit.getCommentById(targetId);

    const queryReason = event.values.queryReason as string | undefined;
    if (!queryReason || queryReason.trim().length < 10) {
        context.ui.showToast("Please provide a more detailed reason for your query.");
        return;
    }

    await addClassificationQueryToQueue({
        username: target.authorName,
        message: queryReason,
        submittingUser: currentUser,
    }, context);

    context.ui.showToast(`Your query about ${target.authorName} has been submitted to the Bot Bouncer team.`);
}
