import { JobContext, TriggerContext, User, WikiPage } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, INTERNAL_BOT } from "./constants.js";
import { addUserToTempDeclineStore, getUserStatus, touchUserStatus, UserStatus } from "./dataStore.js";
import { getControlSubSettings } from "./settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { getPostOrCommentById, getUserOrUndefined } from "./utility.js";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { AsyncSubmission, isUserAlreadyQueued, PostCreationQueueResult, queuePostCreation } from "./postCreation.js";
import pluralize from "pluralize";
import { getUserExtendedFromUser } from "./extendedDevvit.js";
import { evaluateUserAccount, EvaluationResult, storeAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { getEvaluatorVariables } from "./userEvaluation/evaluatorVariables.js";
import { queueKarmaFarmingAccounts } from "./karmaFarmingSubsCheck.js";
import { userIsTrustedSubmitter } from "./trustedSubmitterHelpers.js";

const WIKI_PAGE = "externalsubmissions";

const EXTERNAL_SUBMISSION_QUEUE_KEY = "externalSubmissionQueue";

function getExternalSubmissionDataKey (username: string): string {
    return `externalSubmissionData:${username}`;
}

export interface ExternalSubmission {
    username: string;
    submitter?: string;
    subreddit?: string;
    reportContext?: string;
    publicContext?: boolean;
    targetId?: string;
    initialStatus?: UserStatus;
    evaluatorName?: string;
    hitReason?: string;
    evaluationResults?: EvaluationResult[];
    sendFeedback?: boolean;
    proactive?: boolean;
    immediate?: boolean;
};

const externalSubmissionSchema: JSONSchemaType<ExternalSubmission[]> = {
    type: "array",
    items: {
        type: "object",
        properties: {
            username: { type: "string" },
            submitter: { type: "string", nullable: true },
            subreddit: { type: "string", nullable: true },
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
            immediate: { type: "boolean", nullable: true },
        },
        required: ["username"],
    },
};

export async function addExternalSubmissionFromClientSub (data: ExternalSubmission, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("This function must be called from a client subreddit, not the control subreddit.");
    }

    if (await context.redis.global.zScore(EXTERNAL_SUBMISSION_QUEUE_KEY, data.username)) {
        console.log(`External Submissions: User ${data.username} is already in the external submissions queue.`);
        return;
    }

    await context.redis.global.zAdd(EXTERNAL_SUBMISSION_QUEUE_KEY, { member: data.username, score: new Date().getTime() });
    await context.redis.global.set(getExternalSubmissionDataKey(data.username), JSON.stringify(data), { expiration: addDays(new Date(), 7) });
    console.log(`External Submissions: Added external submission for ${data.username} to the queue.`);
}

export async function addExternalSubmissionToPostCreationQueue (item: ExternalSubmission, immediate: boolean, context: TriggerContext, enableTouch = true): Promise<boolean> {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("This function can only be called from the control subreddit.");
    }

    const currentStatus = await getUserStatus(item.username, context);
    if (currentStatus) {
        console.log(`External Submissions: User ${item.username} already has a status of ${currentStatus.userStatus}.`);
        if (!item.submitter) {
            // Submitted automatically, but in the database already.
            // Need to send back initial status.
            await addUserToTempDeclineStore(item.username, context);
        }
        if (currentStatus.userStatus !== UserStatus.Pending && enableTouch) {
            await touchUserStatus(item.username, currentStatus, context);
        }
        return false;
    }

    const alreadyQueued = await isUserAlreadyQueued(item.username, context);
    if (alreadyQueued) {
        console.log(`External Submissions: User ${item.username} is already in the queue.`);
        return false;
    }

    let user: User | undefined;
    try {
        user = await getUserOrUndefined(item.username, context);
    } catch {
        console.log(`External Submissions: Error fetching data for ${item.username}, skipping.`);
        return false;
    }

    if (!user) {
        console.log(`External Submissions: User ${item.username} is deleted or shadowbanned, skipping.`);
        return false;
    }

    if (!item.submitter || item.submitter === INTERNAL_BOT) {
        // Automatic submission. Check if any evaluators match.
        const variables = await getEvaluatorVariables(context);
        const evaluationResults = await evaluateUserAccount(item.username, variables, context, item.submitter === INTERNAL_BOT);

        if (item.submitter === INTERNAL_BOT) {
            if (item.evaluationResults) {
                item.evaluationResults.push(...evaluationResults);
            } else {
                item.evaluationResults = evaluationResults;
            }
        } else if (evaluationResults.length === 0) {
            console.log(`External Submissions: No evaluators matched for ${item.username}.`);
            await addUserToTempDeclineStore(item.username, context);
            return false;
        } else if (evaluationResults.some(result => result.canAutoBan && result.metThreshold)) {
            console.log(`External Submissions: User ${item.username} met the auto-ban criteria.`);
            item.evaluationResults = evaluationResults;
            item.initialStatus = UserStatus.Banned;
        }
    }

    const initialStatus = item.initialStatus ??= item.submitter && await userIsTrustedSubmitter(item.submitter, context) ? UserStatus.Banned : UserStatus.Pending;

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
        user: await getUserExtendedFromUser(user, context),
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
        evaluatorsChecked: item.evaluatorName !== undefined || (item.evaluationResults !== undefined && item.evaluationResults.length > 0),
    };

    const result = await queuePostCreation(submission, context);
    if (result === PostCreationQueueResult.Queued) {
        let message = `External Submissions: Queued post creation for ${item.username}`;
        if (item.submitter) {
            message += ` submitted by ${item.submitter}`;
        }
        if (item.subreddit) {
            message += ` from /r/${item.subreddit}`;
        }
        console.log(message);

        if (item.sendFeedback) {
            await context.redis.set(`sendFeedback:${item.username}`, "true", { expiration: addDays(new Date(), 7) });
        }

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
    } else {
        console.log(`External Submissions: Post not queued for ${item.username} due to ${result}`);
    }

    return true;
}

export async function handleExternalSubmissionsPageUpdate (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        const controlSubSettings = await getControlSubSettings(context);
        if (!context.subredditName || !controlSubSettings.observerSubreddits?.includes(context.subredditName)) {
            return;
        }
    }

    const externalSubmissionLock = "externalSubmissionLock";
    const isLocked = await context.redis.exists(externalSubmissionLock);
    if (isLocked) {
        console.log("External Submissions: Already processing, skipping this run.");
        return;
    }

    await context.redis.set(externalSubmissionLock, "true", { expiration: addMinutes(new Date(), 1) });

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(context.subredditName, WIKI_PAGE);
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
        await context.redis.del(externalSubmissionLock);
        return;
    }

    const immediate = currentSubmissionList.length === 1;

    const results = await Promise.all(currentSubmissionList.map(async (item) => {
        const alreadyQueued = await context.redis.global.zScore(EXTERNAL_SUBMISSION_QUEUE_KEY, item.username);
        if (alreadyQueued) {
            return false;
        }

        const currentStatus = await getUserStatus(item.username, context);
        if (currentStatus) {
            console.log(`External Submissions: User ${item.username} already has a status of ${currentStatus.userStatus}, skipping.`);
            if (currentStatus.userStatus !== UserStatus.Pending && context.subredditName === CONTROL_SUBREDDIT) {
                await touchUserStatus(item.username, currentStatus, context);
            }
            return false;
        }

        item.immediate = immediate;

        await context.redis.global.set(getExternalSubmissionDataKey(item.username), JSON.stringify(item), { expiration: addDays(new Date(), 7) });
        await context.redis.global.zAdd(EXTERNAL_SUBMISSION_QUEUE_KEY, { score: new Date().getTime(), member: item.username });
        return true;
    }));

    const enqueued = results.filter(r => r).length;

    console.log(`External Submissions: Enqueued ${enqueued} external ${pluralize("submission", enqueued)} for processing.`);

    // Resave.
    await context.reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: WIKI_PAGE,
        content: JSON.stringify([]),
        reason: "Cleared the external submission list",
    });

    await context.redis.del(externalSubmissionLock);

    await processAccountsToCheckFromObserverSubreddit(context);
}

export async function processExternalSubmissionsQueue (context: JobContext): Promise<number> {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("This function can only be called from the control subreddit.");
    }

    const submissionQueue = await context.redis.global.zRange(EXTERNAL_SUBMISSION_QUEUE_KEY, 0, -1);
    if (submissionQueue.length === 0) {
        return 0;
    }

    const executionLimit = addSeconds(new Date(), 10);

    // Process each submission in the queue.
    let processed = 0;
    while (submissionQueue.length > 0 && new Date() < executionLimit) {
        const username = submissionQueue.shift()?.member;
        if (!username) {
            break;
        }

        await context.redis.global.zRem(EXTERNAL_SUBMISSION_QUEUE_KEY, [username]);

        const submissionDataRaw = await context.redis.global.get(getExternalSubmissionDataKey(username));
        if (!submissionDataRaw) {
            console.error(`External Submissions: No data found for ${username}, skipping.`);
            continue;
        }

        const submissionData = JSON.parse(submissionDataRaw) as ExternalSubmission;
        const postSubmitted = await addExternalSubmissionToPostCreationQueue(submissionData, submissionData.immediate ?? false, context);
        await context.redis.del(getExternalSubmissionDataKey(username));
        if (postSubmitted) {
            processed++;
        }
    }

    console.log(`External Submissions: Processed ${processed} external ${pluralize("submission", processed)} from the queue.`);
    return processed;
}

export async function processAccountsToCheckFromObserverSubreddit (context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.observerSubreddits?.includes(subredditName)) {
        return;
    }

    const accountsToCheckPageName = "accountstocheck";
    let accountsToCheckWikiPage: WikiPage | undefined;
    try {
        accountsToCheckWikiPage = await context.reddit.getWikiPage(subredditName, accountsToCheckPageName);
    } catch {
        console.log(`External Submissions: No accounts to check page found in /r/${subredditName}, skipping.`);
        return;
    }

    const accountsToCheck = JSON.parse(accountsToCheckWikiPage.content) as string[];
    if (accountsToCheck.length === 0) {
        return;
    }

    await queueKarmaFarmingAccounts(accountsToCheck, context);
    await context.reddit.updateWikiPage({
        subredditName,
        page: accountsToCheckPageName,
        content: "[]",
        reason: "Cleared the accounts to check list after processing.",
    });

    console.log(`External Submissions: Queued ${accountsToCheck.length} ${pluralize("account", accountsToCheck.length)} from /r/${subredditName} for evaluation.`);
}
