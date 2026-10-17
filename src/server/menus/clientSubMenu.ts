import { context, reddit } from "@devvit/web/server";
import type { MenuItemRequest, T1, T3, UiResponse } from "@devvit/web/shared";
import { addMinutes } from "date-fns";
import { getPostOrCommentById, getUserOrUndefined } from "@fsvreddit/fsv-devvit-web-helpers";
import { CONTROL_SUBREDDIT, FormName, getAlreadyReported, getControlSubSettings, getUserFeedbackPreference, getUserStatus, isBannedWithCache, isModeratorWithCache } from "../core";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";

enum ReportFormField {
    ReportContext = "reportContext",
    PublicContext = "publicContext",
    SendFeedback = "sendFeedback",
}

enum QueryFormField {
    QueryReason = "queryReason",
}

export const handleClientSubredditMenu = async (request: MenuItemRequest): Promise<UiResponse> => {
    const target = await getPostOrCommentById(request.targetId as T1 | T3);

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowNewSubmissions) {
        return {
            showToast: "Bot Bouncer is not currently accepting new submissions.",
        };
    }

    const currentStatus = await getUserStatus(target.authorName);
    if (currentStatus) {
        const queryableStatuses = [UserStatus.Organic, UserStatus.Service];
        if (queryableStatuses.includes(currentStatus.userStatus) && controlSubSettings.allowClassificationQueries) {
            return {
                showForm: {
                    name: FormName.ClientSubQueryUser,
                    form: {
                        title: `Query status for ${target.authorName}`,
                        description: `This user is currently marked as ${currentStatus.userStatus}. If you think this is a bot, please tell us why.`,
                        fields: [
                            {
                                type: "paragraph",
                                label: "Please provide more information that might help us understand why this is a bot",
                                lineHeight: 6,
                                name: QueryFormField.QueryReason,
                            },
                        ],
                    },
                },
            };
        } else {
            return {
                showToast: `${target.authorName} has already been reported to Bot Bouncer with status: ${currentStatus.userStatus}`,
            };
        }
    }

    if (await getAlreadyReported(target.authorName)) {
        return {
            showToast: `${target.authorName} has already been reported recently.`,
        };
    }

    const currentUser = await reddit.getCurrentUser();

    if (!currentUser) {
        return {
            showToast: "You must be logged in to report users to Bot Bouncer.",
        };
    }

    const reporterBlacklist = new Set(controlSubSettings.reporterBlacklist.map(entry => entry.toLowerCase()));
    if (reporterBlacklist.has(currentUser.username.toLowerCase())) {
        return {
            showToast: "You are not currently permitted to submit bots to r/BotBouncer. Please write in to modmail if you believe this is a mistake",
        };
    }

    if (target.authorName === `${context.subredditName}-ModTeam`) {
        return {
            showToast: "You cannot report the subreddit's -ModTeam user.",
        };
    }

    if (target.authorName === currentUser.username) {
        return {
            showToast: "You cannot report yourself.",
        };
    }

    const reportingUserStatus = await getUserStatus(currentUser.username);
    if (reportingUserStatus?.userStatus === UserStatus.Banned) {
        return {
            showToast: "You are currently listed as a bot on r/BotBouncer, so you cannot report other users.",
        };
    }

    if (await isModeratorWithCache(target.authorName)) {
        return {
            showToast: "You cannot report a moderator of this subreddit.",
        };
    }

    if (await isBannedWithCache(currentUser.username, CONTROL_SUBREDDIT, addMinutes(new Date(), 10))) {
        return {
            showToast: "You are currently banned from r/BotBouncer, so you cannot report other users.",
        };
    }

    const user = await getUserOrUndefined(target.authorName);

    if (!user) {
        return {
            showToast: `${target.authorName} appears to be shadowbanned or suspended.`,
        };
    }

    const userFeedbackPreference = await getUserFeedbackPreference(currentUser.username);

    return {
        showForm: {
            name: FormName.ClientSubReportUser,
            form: {
                title: `Report u/${target.authorName} to Bot Bouncer`,
                description: "Thank you for reporting this user. Our team will review the account manually and take appropriate action.",
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
                        defaultValue: userFeedbackPreference,
                        name: ReportFormField.SendFeedback,
                    },
                ],
            },
        },
    };
};
