import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { AsyncSubmission, CLEANUP_LOG_KEY, CONTROL_SUBREDDIT, ControlSubredditJob, deleteAccountInitialEvaluationResults, deleteUserStatus, getAccountInitialEvaluationResults, getUserStatus, ModmailMessage, normaliseHitReason, setUserStatusAndFlair, updateAggregate } from "../..";
import pluralize from "pluralize";
import Ajv, { JSONSchemaType } from "ajv";
import json2md from "json2md";
import { ClassificationReversalsJobData, DeleteRecordsForRemovedUsersData, ReversePostCreationQueueData } from "../../../tasks";

const REVERSED_USERS = "ReversedUsers";

export async function addToReversalsQueue (username: string, days: number) {
    const removalDate = addDays(new Date(), days).getTime();
    await redis.zAdd(REVERSED_USERS, { member: username, score: removalDate });
}

export async function removeUserFromReversalsQueue (username: string) {
    const removedItems = await redis.zRem(REVERSED_USERS, [username]);
    if (removedItems > 0) {
        console.log(`Reversals Queue: Removed ${username} from reversals queue.`);
    }
}

export async function handleReversalCommand (message: ModmailMessage) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Reversal commands can only be handled in the control subreddit.");
    }

    if (message.bodyMarkdown.startsWith("!reverse-classification")) {
        await reverseExtract(message);
    }

    if (message.bodyMarkdown.startsWith("!reverse-postqueue {")) {
        await reverseQueue(message);
    }
}

async function reverseExtract (message: ModmailMessage) {
    const regex = /!reverse-classification (\w{4})/;
    const match = regex.exec(message.bodyMarkdown);

    const identifier = match ? match[1] : undefined;
    if (!identifier) {
        await reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Could not find a valid reversal command in your message. Please ensure you include the correct command.",
            isInternal: true,
        });
        return;
    }

    const reversibleData = await redis.get(`reversibleExtract:${identifier}`);
    if (!reversibleData) {
        await reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ The reversal command has expired or is invalid. Reversals commands are only valid for two hours after the extract is generated.",
            isInternal: true,
        });
        return;
    }

    const users = JSON.parse(reversibleData) as string[];

    await scheduler.runJob<ClassificationReversalsJobData>({
        name: ControlSubredditJob.ClassificationReversals,
        runAt: addSeconds(new Date(), 10),
        data: {
            firstRun: true,
            usersToReverse: users,
            reversedTotal: 0,
            conversationId: message.conversationId,
            jobGuid: crypto.randomUUID(),
        },
    });

    await reddit.modMail.reply({
        conversationId: message.conversationId,
        body: `Scheduled reversal of classifications for ${users.length} ${pluralize("user", users.length)}. You will receive a confirmation message when the process is complete. Note - large reversal batches are done slowly to ensure that subreddits pick up on new classifications.`,
        isInternal: true,
    });
}

export async function classificationReversalsJob (event: TaskRequest<ClassificationReversalsJobData>) {
    const jobGuid = event.data.jobGuid as string | undefined;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Classification Reversals: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const usersToReverse = event.data.usersToReverse ?? [];
    const conversationId = event.data.conversationId;
    let reversedTotal = event.data.reversedTotal ?? 0;

    if (!conversationId) {
        throw new Error("Classification reversals job must be run with a conversation ID.");
    }

    if (usersToReverse.length === 0 && conversationId) {
        await reddit.modMail.reply({
            conversationId,
            body: `✅ Completed reversals. A total of ${reversedTotal} ${pluralize("user", reversedTotal)} had their classifications reversed.`,
            isInternal: true,
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 10);
    let reversedInBatch = 0;

    while (usersToReverse.length > 0 && reversedInBatch < 100 && new Date() < runLimit) {
        const username = usersToReverse.shift();
        if (!username) {
            break;
        }

        const userStatus = await getUserStatus(username);
        if (userStatus?.userStatus !== UserStatus.Banned) {
            continue;
        }

        if (userStatus.trackingPostId) {
            await setUserStatusAndFlair({
                username,
                operator: context.appSlug,
                newStatusOrFlag: UserStatus.Organic,
                currentDetails: userStatus,
            });

            await addToReversalsQueue(username, 7);

            reversedTotal++;
            reversedInBatch++;
        }
    }

    await scheduler.runJob<ClassificationReversalsJobData>({
        name: ControlSubredditJob.ClassificationReversals,
        runAt: addMinutes(new Date(), 1),
        data: {
            firstRun: false,
            usersToReverse,
            conversationId,
            reversedTotal,
            jobGuid: crypto.randomUUID(),
        },
    });
}

interface PostCreationQueueData {
    submitter?: string;
    hitReason?: string;
    hitReasonRegex?: string;
}

const schema: JSONSchemaType<PostCreationQueueData> = {
    type: "object",
    properties: {
        submitter: { type: "string", nullable: true },
        hitReason: { type: "string", nullable: true },
        hitReasonRegex: { type: "string", nullable: true },
    },
    additionalProperties: false,
};

async function reverseQueue (message: ModmailMessage) {
    if (!message.bodyMarkdown.startsWith("!reverse-postqueue {")) {
        return;
    }

    let data: PostCreationQueueData;
    try {
        data = JSON.parse(message.bodyMarkdown.replace("!reverse-postqueue ", "")) as PostCreationQueueData;
    } catch {
        await reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Invalid JSON format for the reverse-postqueue command.",
            isInternal: true,
        });
        return;
    }

    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    if (!validate(data)) {
        await reddit.modMail.reply({
            conversationId: message.conversationId,
            body: `❌ Invalid data for the reverse-postqueue command: ${ajv.errorsText(validate.errors)}`,
            isInternal: true,
        });
        return;
    }

    if (!data.submitter && !data.hitReason && !data.hitReasonRegex) {
        await reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ You must specify at least a submitter, hitReason, or hitReasonRegex to reverse entries in the post creation queue.",
            isInternal: true,
        });
        return;
    }

    await scheduler.runJob<ReversePostCreationQueueData>({
        name: ControlSubredditJob.PostCreationQueueReversals,
        runAt: new Date(),
        data: {
            firstRun: true,
            conversationId: message.conversationId,
            submitter: data.submitter ?? "",
            hitReason: data.hitReason ?? "",
            hitReasonRegex: data.hitReasonRegex ?? "",
            reversedTotal: 0,
            jobGuid: crypto.randomUUID(),
        },
    });
}

const SUBMISSION_QUEUE = "submissionQueue";
const SUBMISSION_DETAILS = "submissionDetails";

export async function reversePostCreationQueue (event: TaskRequest<ReversePostCreationQueueData>) {
    const jobGuid = event.data.jobGuid as string | undefined;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Post Creation Queue Reversals: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const conversationId = event.data.conversationId;
    const submitterFilter = event.data.submitter ?? "";
    const hitReasonFilter = event.data.hitReason ?? "";
    const hitReasonRegexFilter = event.data.hitReasonRegex ?? "";

    let reversedTotal = event.data.reversedTotal ?? 0;

    if (!conversationId) {
        throw new Error("Post creation queue reversals job must be run with a conversation ID.");
    }

    if (event.data.firstRun) {
        console.log("Evaluator Reversals: Starting post creation queue reversals job.");
        const submissionQueue = await redis.zRange(SUBMISSION_QUEUE, 0, -1);
        await scheduler.runJob<ReversePostCreationQueueData>({
            name: ControlSubredditJob.PostCreationQueueReversals,
            runAt: new Date(),
            data: {
                firstRun: false,
                queueUsers: submissionQueue.map(entry => entry.member),
                conversationId,
                submitter: submitterFilter,
                hitReason: hitReasonFilter,
                reversedTotal,
                jobGuid: crypto.randomUUID(),
            },
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 10);

    const queueUsers = event.data.queueUsers ?? [];
    if (queueUsers.length === 0) {
        const remainingCount = await redis.zCard(SUBMISSION_QUEUE);
        const message: json2md.DataObject[] = [
            { p: `✅ Completed post creation queue reversals. A total of ${reversedTotal} ${pluralize("user", reversedTotal)} had their entries removed from the post creation queue.` },
            { p: `There are ${remainingCount} ${pluralize("user", remainingCount)} remaining in the post creation queue.` },
        ];
        await reddit.modMail.reply({
            conversationId,
            body: json2md(message),
            isInternal: true,
        });
        return;
    }

    while (queueUsers.length > 0 && new Date() < runLimit) {
        const username = queueUsers.shift();
        if (!username) {
            break;
        }

        const submissionDetailsRaw = await redis.hGet(SUBMISSION_DETAILS, username);
        if (!submissionDetailsRaw) {
            continue;
        }

        if (submitterFilter) {
            const submissionDetails = JSON.parse(submissionDetailsRaw) as AsyncSubmission;
            if (submissionDetails.details.submitter !== submitterFilter) {
                continue;
            }
        }

        if (hitReasonFilter || hitReasonRegexFilter) {
            const evaluatorData = await getAccountInitialEvaluationResults(username);
            if (!evaluatorData.some((entry) => {
                if (!entry.hitReason) {
                    return false;
                }

                const normalisedHitReason = normaliseHitReason(entry.hitReason);
                return normalisedHitReason.reason.includes(hitReasonFilter) || (hitReasonRegexFilter && new RegExp(hitReasonRegexFilter).test(normalisedHitReason.reason));
            })) {
                continue;
            }
        }

        // Reversible.
        await redis.zRem(SUBMISSION_QUEUE, [username]);
        await redis.hDel(SUBMISSION_DETAILS, [username]);
        await deleteAccountInitialEvaluationResults(username);
        console.log(`Evaluator Reversals: Removed ${username} from the post creation queue.`);
        reversedTotal++;
    }

    await scheduler.runJob<ReversePostCreationQueueData>({
        name: ControlSubredditJob.PostCreationQueueReversals,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: false,
            queueUsers,
            conversationId,
            submitter: submitterFilter,
            hitReason: hitReasonFilter,
            reversedTotal,
            jobGuid: crypto.randomUUID(),
        },
    });
}

export async function deleteRecordsForRemovedUsers (event: TaskRequest<DeleteRecordsForRemovedUsersData | undefined>) {
    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Delete Records: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const runLimit = addSeconds(new Date(), 15);
    const removedUsers = await redis.zRange(REVERSED_USERS, 0, Date.now(), { by: "score" });
    if (removedUsers.length === 0) {
        return;
    }

    let processedCount = 0;
    let deletedCount = 0;
    const processedUsers: string[] = [];

    while (removedUsers.length > 0 && processedCount < 10 && new Date() < runLimit) {
        const firstEntry = removedUsers.shift();
        if (!firstEntry) {
            break;
        }

        const username = firstEntry.member;
        processedUsers.push(username);
        processedCount++;

        const userStatus = await getUserStatus(username);
        if (userStatus?.userStatus !== UserStatus.Organic) {
            continue;
        }

        await updateAggregate(userStatus.userStatus, -1);
        await redis.zRem(CLEANUP_LOG_KEY, [username]);

        await deleteUserStatus(username);

        const post = await reddit.getPostById(userStatus.trackingPostId as T3);
        await post.delete();
        deletedCount++;
    }

    console.log(`Delete Records: Processed ${processedCount} users, deleted ${deletedCount} users. ${removedUsers.length} users left in the queue.`);
    await redis.zRem(REVERSED_USERS, processedUsers);

    if (removedUsers.length > 0) {
        await scheduler.runJob<DeleteRecordsForRemovedUsersData>({
            name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
            runAt: addSeconds(new Date(), 5),
            data: { jobGuid: crypto.randomUUID() },
        });
    }
}
