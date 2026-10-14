import { Comment, context, Post, reddit } from "@devvit/web/server";
import { FormField, isT1, T1, T3, type MenuItemRequest, type UiResponse } from "@devvit/web/shared";
import { HitReason } from "@fsvreddit/bot-bouncer-evaluation";
import { ControlSubAction, FormName, getAccountInitialEvaluationResults, getUsernameFromUrl, getUserStatus, normaliseHitReason } from "../core";
import { getPostOrCommentById } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { isUserPotentiallyBlockingBot } from "../core/controlSubCore/userSummary/blockChecker";

export const handleControlSubredditMenu = async (request: MenuItemRequest): Promise<UiResponse> => {
    let username: string | undefined;
    const target = await getPostOrCommentById(request.targetId as T1 | T3);

    if (isT1(request.targetId)) {
        username = target.authorName;
    } else {
        username = getUsernameFromUrl(target.url);
    }

    if (!username) {
        return {
            showToast: "This option can only be used from a user submission post",
        };
    }

    const currentStatus = await getUserStatus(username);
    if (!currentStatus) {
        return {
            showToast: `${username} is not currently known to Bot Bouncer`,
        };
    }

    const title = `Status for u/${username}`;
    let description = `Current status: ${currentStatus.userStatus}.`;
    if (currentStatus.submitter) {
        description += ` Reported by u/${currentStatus.submitter}.`;
    }
    if (currentStatus.userStatus !== UserStatus.Pending && currentStatus.operator) {
        description += ` Status set by u/${currentStatus.operator}.`;
    }

    const actions: { label: string; value: string }[] = [];
    if (currentStatus.userStatus === UserStatus.Pending) {
        actions.push({ label: "Regenerate Summary", value: ControlSubAction.RegenerateSummary });
    }

    if (currentStatus.submitter && currentStatus.submitter !== context.appSlug) {
        actions.push({ label: "Query Submission", value: ControlSubAction.QuerySubmission });
    }

    actions.push({ label: "Check current evaluation", value: ControlSubAction.CheckCurrentEvaluation });

    actions.push({
        label: "Remove record for user after valid takedown request",
        value: ControlSubAction.RemoveRecordForUser,
    });

    const fields: FormField[] = [
        {
            name: "action",
            type: "select",
            label: "Select an action",
            options: actions,
            multiSelect: false,
            defaultValue: [],
            required: false,
        },
    ];

    const initialEvaluationResult = await getAccountInitialEvaluationResults(username);
    let hitCount = 0;
    for (const hit of initialEvaluationResult) {
        fields.push({
            name: `${hit.botName}${hitCount}`,
            label: `User hit ${hit.botName}`,
            type: "paragraph",
            lineHeight: 4,
            defaultValue: getHitReasonText(hit.hitReason),
        });
        hitCount++;
    }

    let history: (Comment | Post)[] | undefined;
    try {
        history = await reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
            sort: "new",
        }).all();
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
        } else if (await isUserPotentiallyBlockingBot(history)) {
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

    return {
        showForm: {
            name: FormName.ControlSubForm,
            form: {
                title,
                description,
                fields,
            },
        },
    };
};

function getHitReasonText (hitReasonInput?: HitReason): string | undefined {
    const hitReason = hitReasonInput ? normaliseHitReason(hitReasonInput) : undefined;

    let hitReasonText: string | undefined;
    if (hitReason) {
        hitReasonText = hitReason.reason;
        if (hitReason.details.length > 0) {
            hitReasonText += `\n${hitReason.details.map(d => `- ${d.key} : ${d.value}`).join("\n")}`;
        }
    }

    return hitReasonText;
}
