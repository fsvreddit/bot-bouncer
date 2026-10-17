import { context, reddit, settings } from "@devvit/web/server";
import { UiResponse } from "@devvit/web/shared";
import { getPostOrCommentById, getUserOrUndefined } from "@fsvreddit/fsv-devvit-web-helpers";
import type { Context } from "hono";
import { addExternalSubmissionFromClientSub, AppSetting, CONTROL_SUBREDDIT, getControlSubSettings, recordReportForSummary, setAlreadyReported, setUserFeedbackPreference } from "../core";
import { subMonths } from "date-fns";
import { addClassificationQueryToQueue } from "../core/controlSubCore/modmail/classificationQuery";

interface ReportFormData {
    reportContext: string;
    publicContext: boolean;
    sendFeedback: boolean;
}

export const handleReportForm = async (c: Context): Promise<Response> => {
    const data = await c.req.json<ReportFormData>();

    const targetId = context.commentId ?? context.postId;

    if (!targetId) {
        console.log("Error handling report form", context);
        return c.json<UiResponse>({
            showToast: "Sorry, could not report user.",
        });
    }

    const target = await getPostOrCommentById(targetId);

    const user = await getUserOrUndefined(target.authorName);

    if (!user) {
        return c.json<UiResponse>({
            showToast: `${target.authorName} appears to be shadowbanned or suspended.`,
        });
    }

    const controlSubSettings = await getControlSubSettings();
    const contentAgeLimit = subMonths(new Date(), controlSubSettings.maxInactivityMonths ?? 3);

    if (target.createdAt < contentAgeLimit) {
        const userContent = await reddit.getCommentsAndPostsByUser({
            username: target.authorName,
            limit: 100,
            sort: "new",
        }).all();

        if (!userContent.some(item => item.createdAt > contentAgeLimit)) {
            return c.json<UiResponse>({
                showToast: "You can only report users with recent content on their history.",
            });
        }
    }

    const currentUser = await reddit.getCurrentUser();
    const removeReportedContent = await settings.get<boolean>(AppSetting.RemoveReportedContentOnReport);

    await Promise.all([
        addExternalSubmissionFromClientSub({
            username: target.authorName,
            subreddit: context.subredditName,
            submitter: currentUser?.username,
            reportContext: data.reportContext,
            publicContext: data.publicContext,
            targetId: target.id,
            sendFeedback: data.sendFeedback,
            immediate: true,
        }),
        recordReportForSummary(target.authorName),
    ]);

    let reportedContentRemoved = false;
    let reportedContentRemoveFailed = false;

    if (removeReportedContent && !target.removed && !target.spam) {
        try {
            await target.remove();
            reportedContentRemoved = true;
        } catch (error) {
            reportedContentRemoveFailed = true;
            console.error(`Failed to remove reported content ${target.id} for ${target.authorName}:`, error);
        }
    }

    await setAlreadyReported(target.authorName);

    if (currentUser?.username) {
        await setUserFeedbackPreference(currentUser.username, data.sendFeedback);
    }

    let toastMessage = `${target.authorName} has been submitted to /r/${CONTROL_SUBREDDIT}. A tracking post will be created shortly.`;

    if (reportedContentRemoved) {
        toastMessage += " The reported content was removed.";
    } else if (reportedContentRemoveFailed) {
        toastMessage += " The reported content could not be removed.";
    }

    return c.json<UiResponse>({
        showToast: toastMessage,
    });
};

interface QueryFormData {
    queryReason: string;
}

export const handleQueryForm = async (c: Context): Promise<Response> => {
    const data = await c.req.json<QueryFormData>();

    const currentUser = await reddit.getCurrentUsername();
    if (!currentUser) {
        return c.json<UiResponse>({
            showToast: "You must be logged in to report users to Bot Bouncer.",
        });
    }

    const targetId = context.commentId ?? context.postId;
    if (!targetId) {
        console.log("Error handling query form", context);
        return c.json<UiResponse>({
            showToast: "Sorry, could not query user.",
        });
    }

    const target = await getPostOrCommentById(targetId);

    const queryReason = data.queryReason;
    if (!queryReason || queryReason.trim().length < 10) {
        return c.json<UiResponse>({
            showToast: "Please provide a more detailed reason for your query.",
        });
    }

    await addClassificationQueryToQueue({
        username: target.authorName,
        message: queryReason,
        submittingUser: currentUser,
    });

    return c.json<UiResponse>({
        showToast: `Your query about ${target.authorName} has been submitted to the Bot Bouncer team.`,
    });
};
