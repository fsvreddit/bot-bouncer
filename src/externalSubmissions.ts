import { JobContext, TriggerContext, WikiPage } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { addUserToTempDeclineStore, getUserStatus, setUserStatus, UserStatus } from "./dataStore.js";
import { ControlSubSettings, getControlSubSettings } from "./settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { getPostOrCommentById } from "./utility.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { AsyncSubmission, queuePostCreation } from "./postCreation.js";
import pluralize from "pluralize";
import { getUserExtended } from "./extendedDevvit.js";
import { evaluateUserAccount, EvaluationResult, storeAccountInitialEvaluationResults, storeEvaluationStatistics } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { queueKarmaFarmingAccounts } from "./karmaFarmingSubsCheck.js";

const WIKI_PAGE = "externalsubmissions";

export interface ExternalSubmission {
    username: string;
    submitter?: string;
    reportContext?: string;
    publicContext?: boolean;
    targetId?: string;
    initialStatus?: UserStatus;
    evaluatorName?: string;
    hitReason?: string;
    evaluationResults?: EvaluationResult[];
    sendFeedback?: boolean;
    proactive?: boolean;
};

const externalSubmissionSchema: JSONSchemaType<ExternalSubmission[]> = {
    type: "array",
    items: {
        type: "object",
        properties: {
            username: { type: "string" },
            submitter: { type: "string", nullable: true },
            reportContext: { type: "string", nullable: true },
            publicContext: { type: "boolean", nullable: true },
            targetId: { type: "string", nullable: true },
            initialStatus: { type: "string", nullable: true, enum: Object.values(UserStatus) },
            evaluatorName: { type: "string", nullable: true },
            hitReason: { type: "string", nullable: true },
            evaluationResults: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        botName: { type: "string" },
                        hitReason: { type: "string", nullable: true },
                        canAutoBan: { type: "boolean" },
                        metThreshold: { type: "boolean" },
                    },
                    required: ["botName", "canAutoBan", "metThreshold"],
                },
                nullable: true,
            },
            sendFeedback: { type: "boolean", nullable: true },
            proactive: { type: "boolean", nullable: true },
        },
        required: ["username"],
    },
};

export async function addExternalSubmissionFromClientSub (data: ExternalSubmission, submissionType: "automatic" | "manual", context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const redisKey = `externalSubmission:${data.username}`;
    const alreadyDone = await context.redis.exists(redisKey);
    if (alreadyDone) {
        return;
    }

    await context.redis.set(redisKey, new Date().getTime().toString(), { expiration: addMinutes(new Date(), 5) });

    // Set local status
    await setUserStatus(data.username, {
        userStatus: UserStatus.Pending,
        lastUpdate: new Date().getTime(),
        submitter: data.submitter,
        operator: context.appName,
        trackingPostId: "",
    }, context);

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        //
    }

    const currentUserList = JSON.parse(wikiPage?.content ?? "[]") as ExternalSubmission[];

    const ajv = new Ajv.default();
    const validate = ajv.compile(externalSubmissionSchema);
    if (!validate(currentUserList)) {
        console.error("External submission list is invalid.", ajv.errorsText(validate.errors));
        return;
    }

    if (currentUserList.some(item => item.username === data.username)) {
        return;
    }

    currentUserList.push(data);

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify(currentUserList),
        reason: `Added a user via ${context.subredditName ? `/r/${context.subredditName}` : "an unknown subreddit"}. Type: ${submissionType}`,
    });
}

export async function addExternalSubmissionToPostCreationQueue (item: ExternalSubmission, immediate: boolean, controlSubSettings: ControlSubSettings, context: TriggerContext): Promise<boolean> {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("This function can only be called from the control subreddit.");
    }

    const user = await getUserExtended(item.username, context);
    if (!user) {
        console.log(`External Submissions: User ${item.username} is deleted or shadowbanned, skipping.`);
        return false;
    }

    const currentStatus = await getUserStatus(item.username, context);
    if (currentStatus) {
        console.log(`External Submissions: User ${item.username} already has a status of ${currentStatus.userStatus}.`);
        if (!item.submitter) {
            // Submitted automatically, but in the database already.
            // Need to send back initial status.
            await addUserToTempDeclineStore(item.username, context);
        }
        return false;
    }

    if (!item.submitter) {
        // Automatic submission. Check if any evaluators match.
        const variables = await getEvaluatorVariables(context);
        const evaluationResults = await evaluateUserAccount(item.username, variables, context, false);
        if (evaluationResults.length === 0) {
            console.log(`External Submissions: No evaluators matched for ${item.username}.`);
            await addUserToTempDeclineStore(item.username, context);
            return false;
        }
    }

    const initialStatus = item.initialStatus ??= item.submitter && controlSubSettings.trustedSubmitters.includes(item.submitter) ? UserStatus.Banned : UserStatus.Pending;

    let commentToAdd: string | undefined;

    if (item.proactive) {
        commentToAdd = json2md([
            { p: "This user was detected automatically through proactive bot hunting activity." },
            { p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` },
        ]);
    } else if (item.reportContext) {
        const body: json2md.DataObject[] = [
            { p: "The submitter added the following context for this submission:" },
            { blockquote: item.reportContext },
        ];

        if (item.targetId) {
            const target = await getPostOrCommentById(item.targetId, context);
            body.push({ p: `User was reported via [this ${isLinkId(target.id) ? "post" : "comment"}](${target.permalink})` });
        }

        body.push({ p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` });
        commentToAdd = json2md(body);
    }

    const submission: AsyncSubmission = {
        user,
        details: {
            userStatus: initialStatus,
            lastUpdate: new Date().getTime(),
            submitter: item.submitter,
            operator: context.appName,
            trackingPostId: "",
            reportedAt: new Date().getTime(),
        },
        immediate,
        commentToAdd,
        removeComment: item.publicContext === false,
    };

    await queuePostCreation(submission, context);
    if (item.sendFeedback) {
        await context.redis.set(`sendFeedback:${item.username}`, "true", { expiration: addDays(new Date(), 1) });
    }
    console.log(`External Submissions: Queued post creation for ${item.username}`);

    if (item.evaluatorName) {
        const evaluationResult = {
            botName: item.evaluatorName,
            hitReason: item.hitReason,
            canAutoBan: true,
            metThreshold: true,
        } as EvaluationResult;
        await storeAccountInitialEvaluationResults(item.username, [evaluationResult], context);
    } else if (item.evaluationResults) {
        await storeAccountInitialEvaluationResults(item.username, item.evaluationResults, context);
    }

    return true;
}

export async function handleExternalSubmissionsPageUpdate (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        //
    }

    const currentSubmissionList = JSON.parse(wikiPage?.content ?? "[]") as ExternalSubmission[];

    const ajv = new Ajv.default();
    const validate = ajv.compile(externalSubmissionSchema);
    if (!validate(currentSubmissionList)) {
        console.error("External submission list is invalid.", ajv.errorsText(validate.errors));
        return;
    }

    if (currentSubmissionList.length === 0) {
        return;
    }

    const executionLimit = addSeconds(new Date(), 25);
    const controlSubSettings = await getControlSubSettings(context);
    const immediate = currentSubmissionList.length === 1;
    let added = 0;
    while (currentSubmissionList.length > 0 && new Date() < executionLimit) {
        const submission = currentSubmissionList.shift();
        if (!submission) {
            break;
        }
        const postSubmitted = await addExternalSubmissionToPostCreationQueue(submission, immediate, controlSubSettings, context);
        if (postSubmitted) {
            added++;
        }
    }

    // Resave.
    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: WIKI_PAGE,
        content: JSON.stringify(currentSubmissionList),
        reason: "Cleared the external submission list",
    });

    console.log(`External Submissions: Added ${added} external ${pluralize("submission", added)} to the queue.`);
}

export async function processExternalSubmissionsFromObserverSubreddits (_: unknown, context: JobContext) {
    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.observerSubreddits || controlSubSettings.observerSubreddits.length === 0) {
        console.log("External Submissions: No observer subreddits configured, skipping external submissions processing.");
        return;
    }

    let processed = 0;
    for (const subreddit of controlSubSettings.observerSubreddits) {
        let submissionsWikiPage: WikiPage | undefined;
        try {
            submissionsWikiPage = await context.reddit.getWikiPage(subreddit, WIKI_PAGE);
        } catch {
            console.log(`External Submissions: No external submissions page found in /r/${subreddit}, skipping.`);
            continue;
        }

        const currentSubmissionList = JSON.parse(submissionsWikiPage.content) as ExternalSubmission[];
        if (currentSubmissionList.length === 0) {
            console.log(`External Submissions: No external submissions found in /r/${subreddit}.`);
            continue;
        }

        for (const submission of currentSubmissionList) {
            const postSubmitted = await addExternalSubmissionToPostCreationQueue(submission, false, controlSubSettings, context);
            if (postSubmitted) {
                console.log(`External Submissions: Processed external submission for ${submission.username} from /r/${subreddit}.`);
                processed++;
            }

            if (submission.evaluationResults && submission.evaluationResults.length > 0) {
                await storeAccountInitialEvaluationResults(submission.username, submission.evaluationResults, context);
                await storeEvaluationStatistics(submission.evaluationResults, context);
            }
        }

        await context.reddit.updateWikiPage({
            subredditName: subreddit,
            page: WIKI_PAGE,
            content: "[]",
            reason: "Cleared the external submission list after processing.",
        });
    }

    if (processed > 0) {
        console.log(`External Submissions: Processed ${processed} external ${pluralize("submission", processed)} from observer subreddits.`);
    }

    for (const subreddit of controlSubSettings.observerSubreddits) {
        const accountsToCheckPageName = "accountstocheck";
        let accountsToCheckWikiPage: WikiPage | undefined;
        try {
            accountsToCheckWikiPage = await context.reddit.getWikiPage(subreddit, accountsToCheckPageName);
        } catch {
            console.log(`External Submissions: No accounts to check page found in /r/${subreddit}, skipping.`);
            continue;
        }

        const accountsToCheck = JSON.parse(accountsToCheckWikiPage.content) as string[];
        if (accountsToCheck.length === 0) {
            continue;
        }

        await queueKarmaFarmingAccounts(accountsToCheck, context);
        await context.reddit.updateWikiPage({
            subredditName: subreddit,
            page: accountsToCheckPageName,
            content: "[]",
            reason: "Cleared the accounts to check list after processing.",
        });

        console.log(`External Submissions: Queued ${accountsToCheck.length} ${pluralize("account", accountsToCheck.length)} from /r/${subreddit} for evaluation.`);
    }
}
