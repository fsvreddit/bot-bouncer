import { Comment, Context, Form, FormField, FormOnSubmitEvent, JSONObject, Post } from "@devvit/public-api";
import { getUsernameFromUrl } from "./utility.js";
import { deleteUserStatus, getUsernameFromPostId, getUserStatus, updateAggregate, UserStatus } from "./dataStore.js";
import { controlSubForm, controlSubQuerySubmissionForm } from "./main.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { evaluateUserAccount, getAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { CLEANUP_LOG_KEY } from "./cleanup.js";
// eslint-disable-next-line camelcase
import { FieldConfig_Selection_Item } from "@devvit/protos";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { isUserPotentiallyBlockingBot } from "./UserSummary/blockChecker.js";

enum ControlSubAction {
    RegenerateSummary = "generateSummary",
    QuerySubmission = "querySubmission",
    RemoveRecordForUser = "removeRecordForUser",
    CheckCurrentEvaluation = "checkCurrentEvaluation",
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
    // eslint-disable-next-line camelcase
    const actions: FieldConfig_Selection_Item[] = [];
    if (currentStatus.userStatus === UserStatus.Pending) {
        actions.push({ label: "Regenerate Summary", value: ControlSubAction.RegenerateSummary });

        if (currentStatus.submitter && currentStatus.submitter !== context.appName) {
            actions.push({ label: "Query Submission", value: ControlSubAction.QuerySubmission });
        }

        actions.push({
            label: "Remove record for user after valid takedown request",
            value: ControlSubAction.RemoveRecordForUser,
        });
    }

    if (currentStatus.submitter && currentStatus.submitter !== context.appName) {
        actions.push({ label: "Query Submission", value: ControlSubAction.QuerySubmission });
    }

    actions.push({ label: "Check current evaluation", value: ControlSubAction.CheckCurrentEvaluation });

    actions.push({
        label: "Remove record for user after valid takedown request",
        value: ControlSubAction.RemoveRecordForUser,
    });

    fields.push({
        name: "action",
        type: "select",
        label: "Select an action",
        options: actions,
        multiSelect: false,
        defaultValue: [],
        required: false,
    });

    const initialEvaluationResult = await getAccountInitialEvaluationResults(username, context);
    let hitCount = 0;
    for (const hit of initialEvaluationResult) {
        let hitReason: string | undefined;
        if (typeof hit.hitReason === "string") {
            hitReason = hit.hitReason;
        } else if (hit.hitReason) {
            hitReason = hit.hitReason.reason;
        }
        fields.push({
            name: `${hit.botName}${hitCount}`,
            label: `User hit ${hit.botName}`,
            type: "paragraph",
            lineHeight: 4,
            defaultValue: hitReason,
        });
        hitCount++;
    }

    let history: (Comment | Post)[] | undefined;
    try {
        history = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
            sort: "new",
        }).all();
        console.log(`History length: ${history.length}`);
    } catch {
        //
    }

    if (history) {
        if (history.length === 0) {
            fields.push({
                name: "noHistory",
                label: "No history found for this user - user may be blocking or suspended.",
                type: "string",
            });
        } else if (await isUserPotentiallyBlockingBot(history, context)) {
            fields.push({
                name: "potentiallyBlocking",
                label: "User may be blocking Bot Bouncer.",
                type: "string",
            });
        } else {
            fields.push({
                name: "histLength",
                label: `User has ${history.length} posts/comments visible to Bot Bouncer.`,
                type: "string",
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
        case ControlSubAction.CheckCurrentEvaluation:
            await reevaluateUserAccount(username, context);
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

export const controlSubQuerySubmissionFormDefinition: Form = {
    fields: [
        {
            type: "paragraph",
            label: "Additional text to include in modmail to submitter",
            placeholder: "This doesn't look like a bot to me, but maybe you can see something we didn't!",
            name: "querySubmissionText",
            lineHeight: 4,
        },
    ],
};

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
    const currentStatus = await getUserStatus(username, context);

    const txn = await context.redis.watch();
    await txn.multi();

    if (currentStatus && currentStatus.userStatus !== UserStatus.Purged && currentStatus.userStatus !== UserStatus.Retired) {
        await updateAggregate(currentStatus.userStatus, -1, txn);
    }

    await txn.zRem(CLEANUP_LOG_KEY, [username]);
    await txn.exec();

    if (post.authorName === context.appName) {
        await post.delete();
    } else {
        await post.remove();
    }

    await deleteUserStatus(username, context);

    context.ui.showToast(`Removed all data and deleted post for u/${username}.`);
}

async function reevaluateUserAccount (username: string, context: Context) {
    const fields: FormField[] = [];

    const variables = await getEvaluatorVariables(context);
    const evaluationResults = await evaluateUserAccount({
        username,
        variables,
    }, context);
    if (evaluationResults.length === 0) {
        fields.push({
            type: "string",
            label: "User did not match evaluators",
            name: "noMatch",
        });
    } else {
        for (const hit of evaluationResults) {
            if (hit.hitReason) {
                let hitReason: string;
                if (typeof hit.hitReason === "string") {
                    hitReason = hit.hitReason;
                } else {
                    hitReason = hit.hitReason.reason;
                }

                fields.push({
                    type: "paragraph",
                    label: `User hit ${hit.botName}`,
                    name: hit.botName,
                    lineHeight: Math.min(Math.ceil(hitReason.length / 60), 8),
                    defaultValue: hitReason,
                });
            } else {
                fields.push({
                    type: "string",
                    label: `User hit ${hit.botName}`,
                    name: hit.botName,
                    placeholder: "No detail available",
                });
            }
        }
    }

    context.ui.showForm(controlSubForm, { title: "Evaluation Results", fields: fields as unknown as JSONObject });
}
