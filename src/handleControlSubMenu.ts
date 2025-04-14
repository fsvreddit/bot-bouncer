import { Comment, Context, FormField, FormOnSubmitEvent, JSONObject, Post } from "@devvit/public-api";
import { getUsernameFromUrl } from "./utility.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { controlSubForm } from "./main.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { getAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";

enum ControlSubAction {
    RegenerateSummary = "generateSummary",
    QuerySubmission = "querySubmission",
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

        fields.push({
            name: "action",
            type: "select",
            label: "Select an action",
            options: formOptions,
            multiSelect: false,
            required: true,
        });
    }

    if (currentStatus.userStatus === UserStatus.Banned || currentStatus.lastStatus === UserStatus.Banned) {
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
            await handleQuerySubmission(username, post, context);
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

async function handleQuerySubmission (username: string, post: Post, context: Context) {
    const currentStatus = await getUserStatus(username, context);
    if (!currentStatus?.submitter) {
        context.ui.showToast("Cannot identify who reported this user.");
        return;
    }

    const modmail = `Hi u/${currentStatus.submitter}, you recently reported u/${username} to Bot Bouncer, their tracking post can be found [here](${post.permalink}}).

We can't determine why this user might be considered a bot based on their profile alone. If you're able to add more context to help us, please reply to this message.`;

    const response = await context.reddit.modMail.createConversation({
        to: currentStatus.submitter,
        subject: `Query regarding u/${username} on r/BotBouncer`,
        subredditName: CONTROL_SUBREDDIT,
        body: modmail,
        isAuthorHidden: true,
    });

    if (response.conversation.id) {
        await context.reddit.modMail.archiveConversation(response.conversation.id);
    }

    context.ui.showToast("Query sent to the original reporter.");
}
