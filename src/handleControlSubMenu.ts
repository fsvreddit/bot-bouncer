import { Comment, Context, FormField, FormOnSubmitEvent, JSONObject, Post } from "@devvit/public-api";
import { getUsernameFromUrl } from "./utility.js";
import { deleteUserStatus, getUsernameFromPostId, getUserStatus, UserStatus } from "./dataStore.js";
import { controlSubForm, controlSubQuerySubmissionForm } from "./main.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { getAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";

enum ControlSubAction {
    RegenerateSummary = "generateSummary",
    QuerySubmission = "querySubmission",
    RemoveRecordForUser = "removeRecordForUser",
}

export async function handleControlSubReportUser (target: Post | Comment, context: Context) {
    let username: string | undefined;
    if (target instanceof Comment) {
        username = target.authorName;
    } else {
        username = getUsernameFromUrl(target.url);
    }

    if (!username) {
        context.ui.showToast("This option can only be used from a user submission post");
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus) {
        context.ui.showToast(`${username} is not currently known to Bot Bouncer`);
        return;
    }

    const title = `Status for u/${username}`;
    let description = `Current status: ${currentStatus.userStatus}.`;
    if (currentStatus.submitter) {
        description += ` Reported by u/${currentStatus.submitter}.`;
    }
    if (currentStatus.userStatus !== UserStatus.Pending && currentStatus.operator) {
        description += ` Status set by u/${currentStatus.operator}.`;
    }

    const fields: FormField[] = [];
    if (currentStatus.userStatus === UserStatus.Pending) {
        const formOptions = [
            { label: "Regenerate Summary", value: ControlSubAction.RegenerateSummary },
        ];

        if (currentStatus.submitter && currentStatus.submitter !== context.appName) {
            formOptions.push({ label: "Query Submission", value: ControlSubAction.QuerySubmission });
        }

        formOptions.push({
            label: "Remove record for user after valid takedown request",
            value: ControlSubAction.RemoveRecordForUser,
        });

        fields.push({
            name: "action",
            type: "select",
            label: "Select an action",
            options: formOptions,
            multiSelect: false,
            required: true,
        });
    }

    const initialEvaluationResult = await getAccountInitialEvaluationResults(username, context);
    for (const hit of initialEvaluationResult) {
        if (hit.hitReason) {
            fields.push({
                name: hit.botName,
                label: `User hit ${hit.botName}`,
                type: "paragraph",
                lineHeight: Math.min(Math.ceil(hit.hitReason.length / 60), 8),
                defaultValue: hit.hitReason,
            });
        } else {
            fields.push({
                name: hit.botName,
                label: `User hit ${hit.botName}`,
                type: "string",
                placeholder: "No detail available",
            });
        }
    }

    context.ui.showForm(controlSubForm, { title, description, fields: fields as unknown as JSONObject });
}

export async function handleControlSubForm (event: FormOnSubmitEvent<JSONObject>, context: Context) {
    if (!event.values.action) {
        return;
    }

    const [action] = event.values.action as ControlSubAction[];
    const postId = context.postId;

    if (!postId) {
        context.ui.showToast("This option can only be used from a user submission post");
        return;
    }

    const post = await context.reddit.getPostById(postId);
    const username = getUsernameFromUrl(post.url);

    if (!username) {
        context.ui.showToast("This option can only be used from a user submission post");
        return;
    }

    switch (action) {
        case ControlSubAction.RegenerateSummary:
            await handleRegenerateSummary(username, post, context);
            break;
        case ControlSubAction.QuerySubmission:
            context.ui.showForm(controlSubQuerySubmissionForm);
            break;
        case ControlSubAction.RemoveRecordForUser:
            await handleRemoveRecordForUser(username, post, context);
            break;
        default:
            context.ui.showToast("You must select an action");
            break;
    }
}

async function handleRegenerateSummary (username: string, post: Post, context: Context) {
    const comment = await post.comments.all();
    const commentToDelete = comment.find(c => c.authorName === context.appName && c.body.startsWith("## Account Properties"));

    if (commentToDelete) {
        await commentToDelete.delete();
    }

    await createUserSummary(username, post.id, context);

    context.ui.showToast("Summary regenerated");
}

export async function sendQueryToSubmitter (event: FormOnSubmitEvent<JSONObject>, context: Context) {
    if (!context.postId) {
        context.ui.showToast("This option can only be used from a user submission post");
        return;
    }

    const post = await context.reddit.getPostById(context.postId);
    const username = await getUsernameFromPostId(post.id, context);
    if (!username) {
        context.ui.showToast("This option can only be used from a user submission post");
        return;
    }

    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus?.submitter) {
        context.ui.showToast("Cannot identify who reported this user.");
        return;
    }

    const modmailText: json2md.DataObject[] = [
        { p: `Hi /u/${currentStatus.submitter},` },
        { p: `We are reaching out to you regarding your recent [report](${post.permalink}) of u/${username} on r/BotBouncer.` },
        { p: "We are unable to determine why this user might be considered a bot based on a look at their profile alone. If you're able to add more context to help us, please reply to this message." },
    ];

    const querySubmissionText = event.values.querySubmissionText as string | undefined;
    if (querySubmissionText) {
        modmailText.push({ p: "The mods of /r/BotBouncer have added the following extra information:" });
        modmailText.push({ blockquote: querySubmissionText });
    }

    const response = await context.reddit.modMail.createConversation({
        to: currentStatus.submitter,
        subject: `Query regarding u/${username} on r/BotBouncer`,
        subredditName: CONTROL_SUBREDDIT,
        body: json2md(modmailText),
        isAuthorHidden: true,
    });

    if (response.conversation.id) {
        await context.reddit.modMail.archiveConversation(response.conversation.id);
    }

    context.ui.showToast(`Query sent to /u/${currentStatus.submitter}.`);
}

async function handleRemoveRecordForUser (username: string, post: Post, context: Context) {
    await deleteUserStatus(username, context);
    if (post.authorName === context.appName) {
        await post.delete();
        return;
    } else {
        await post.remove();
    }

    context.ui.showToast(`Removed all data and deleted post for u/${username}.`);
}
