import { context, Post, reddit, redis } from "@devvit/web/server";
import { FormField, JsonObject, UiResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { CLEANUP_LOG_KEY, CONTROL_SUBREDDIT, ControlSubAction, deleteUserStatus, evaluateUserAccount, FormName, getHitReasonText, getUsernameFromUrl, getUserStatus, updateAggregate } from "../core";
import { getSummaryForUser, regenerateSummary } from "../core/controlSubCore/userSummary";
import json2md from "json2md";
import { markdownToText } from "../core/controlSubCore/modmail";
import { getEvaluatorVariables } from "../core/userEvaluation";

export const handleControlSubForm = async (c: Context): Promise<Response> => {
    const data = await c.req.json<JsonObject>();

    if (!data.action) {
        return c.json<UiResponse>({ });
    }

    const [action] = data.action as ControlSubAction[];
    const postId = context.postId;

    if (!postId) {
        return c.json<UiResponse>({
            showToast: "This option can only be used from a user submission post",
        });
    }

    const post = await reddit.getPostById(postId);
    const username = getUsernameFromUrl(post.url);

    if (!username) {
        return c.json<UiResponse>({
            showToast: "This option can only be used from a user submission post",
        });
    }

    switch (action) {
        case ControlSubAction.RegenerateSummary:
            await regenerateSummary(username, post);
            return c.json<UiResponse>({
                showToast: "Summary regenerated",
            });
        case ControlSubAction.QuerySubmission:
            return c.json<UiResponse>({
                showForm: {
                    name: FormName.ControlSubQuerySubmissionForm,
                    form: {
                        fields: [
                            {
                                type: "paragraph",
                                label: "Additional text to include in modmail to submitter",
                                placeholder: "This doesn't look like a bot to me, but maybe you can see something we didn't!",
                                name: "querySubmissionText",
                                lineHeight: 4,
                            },
                        ],
                    },
                },
            });
        case ControlSubAction.RemoveRecordForUser:
            return c.json<UiResponse>(await handleRemoveRecordForUser(username, post));
        case ControlSubAction.CheckCurrentEvaluation:
            return c.json<UiResponse>(await reevaluateUserAccount(username));
        default:
            return c.json<UiResponse>({
                showToast: "You must select an action",
            });
    }
};

export const handleControlSubQuerySubmissionForm = async (c: Context): Promise<Response> => {
    const data = await c.req.json<{ querySubmissionText: string }>();

    if (!context.postId) {
        return c.json<UiResponse>({
            showToast: "This option can only be used from a user submission post",
        });
    }

    const post = await reddit.getPostById(context.postId);
    const username = getUsernameFromUrl(post.url);
    if (!username) {
        return c.json<UiResponse>({
            showToast: "This option can only be used from a user submission post",
        });
    }

    const currentStatus = await getUserStatus(username);
    if (!currentStatus?.submitter) {
        return c.json<UiResponse>({
            showToast: "Cannot identify who reported this user.",
        });
    }

    const modmailText: json2md.DataObject[] = [
        { p: `Hi /u/${currentStatus.submitter},` },
        { p: `We are reaching out to you regarding your recent [report](${post.permalink}) of u/${username} on r/BotBouncer.` },
        { p: "We are unable to determine why this user might be considered a bot based on a look at their profile alone. If you're able to add more context to help us, please reply to this message." },
    ];

    const querySubmissionText = data.querySubmissionText;
    if (querySubmissionText) {
        modmailText.push({ p: "The mods of /r/BotBouncer have added the following extra information:" });
        modmailText.push({ blockquote: querySubmissionText });
    }

    const response = await reddit.modMail.createConversation({
        to: currentStatus.submitter,
        subject: `Query regarding u/${username} on r/BotBouncer`,
        subredditName: CONTROL_SUBREDDIT,
        body: json2md(modmailText),
        isAuthorHidden: true,
    });

    if (response.conversation.id) {
        const message = await getSummaryForUser(username, "modmail");

        const currentUser = await reddit.getCurrentUser();
        if (currentUser) {
            message.unshift({ hr: "" });
            message.unshift({ p: `This query was sent by u/${currentUser.username}.` });
        }

        const modmailStrings = markdownToText(message);

        for (const string of modmailStrings) {
            await reddit.modMail.reply({
                body: string,
                conversationId: response.conversation.id,
                isInternal: true,
            });
        }

        await reddit.modMail.archiveConversation(response.conversation.id);
    }

    return c.json<UiResponse>({
        showToast: `Query sent to /u/${currentStatus.submitter}.`,
    });
};

async function handleRemoveRecordForUser (username: string, post: Post): Promise<UiResponse> {
    const currentStatus = await getUserStatus(username);

    if (currentStatus && currentStatus.userStatus !== UserStatus.Purged && currentStatus.userStatus !== UserStatus.Retired) {
        await updateAggregate(currentStatus.userStatus, -1);
    }

    await redis.zRem(CLEANUP_LOG_KEY, [username]);

    if (post.authorName === context.appSlug) {
        await post.delete();
    } else {
        await post.remove();
    }

    await deleteUserStatus(username);

    return {
        showToast: `Removed all data and deleted post for u/${username}.`,
    };
}

async function reevaluateUserAccount (username: string): Promise<UiResponse> {
    const fields: FormField[] = [];

    const variables = await getEvaluatorVariables();
    const evaluationResults = await evaluateUserAccount({
        username,
        variables,
    });

    if (evaluationResults.length === 0) {
        fields.push({
            type: "string",
            label: "User did not match evaluators",
            name: "noMatch",
        });
    } else {
        let index = 0;
        for (const hit of evaluationResults) {
            const hitReasonText = getHitReasonText(hit.hitReason);
            if (hitReasonText) {
                fields.push({
                    type: "paragraph",
                    label: `User hit ${hit.botName}`,
                    name: `hit.botName_${index}`,
                    lineHeight: Math.min(Math.ceil(hitReasonText.length / 60), 8),
                    defaultValue: hitReasonText,
                });
            } else {
                fields.push({
                    type: "string",
                    label: `User hit ${hit.botName}`,
                    name: `hit.botName_${index}`,
                    placeholder: "No detail available",
                });
            }
            index++;
        }
    }

    return {
        showForm: {
            name: FormName.ShowCurrentEvaluationForm,
            form: {
                title: "Evaluation Results",
                fields,
            },
        },
    };
}

export const handleShowCurrentEvaluationResultsForm = (c: Context): Response => c.json<UiResponse>({ });
