import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { deleteUserStatus, getUserStatus, updateAggregate, UserStatus } from "../dataStore.js";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob, PostFlairTemplate } from "../constants.js";
import { deleteAccountInitialEvaluationResults, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { CLEANUP_LOG_KEY } from "../cleanup.js";
import { ModmailMessage } from "./modmail.js";
import Ajv, { JSONSchemaType } from "ajv";
import { AsyncSubmission } from "../postCreation.js";
import pluralize from "pluralize";

const REVERSED_USERS = "ReversedUsers";

export async function addToReversalsQueue (username: string, days: number, context: TriggerContext) {
    const removalDate = addDays(new Date(), days).getTime();
    await context.redis.zAdd(REVERSED_USERS, { member: username, score: removalDate });
}

export async function handleReversalCommand (message: ModmailMessage, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Reversal commands can only be handled in the control subreddit.");
    }

    if (message.bodyMarkdown.startsWith("!reverse-classification")) {
        await reverseExtract(message, context);
    }

    if (message.bodyMarkdown.startsWith("!reverse-postqueue {")) {
        await reverseQueue(message, context);
    }
}

async function reverseExtract (message: ModmailMessage, context: TriggerContext) {
    const regex = /!reverse-classification (\w{4})/;
    const match = regex.exec(message.bodyMarkdown);

    const identifier = match ? match[1] : undefined;
    if (!identifier) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Could not find a valid reversal command in your message. Please ensure you include the correct command.",
            isInternal: true,
        });
        return;
    }

    const reversibleData = await context.redis.get(`reversibleExtract:${identifier}`);
    if (!reversibleData) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ The reversal command has expired or is invalid. Reversals commands are only valid for two hours after the extract is generated.",
            isInternal: true,
        });
        return;
    }

    const users = JSON.parse(reversibleData) as string[];

    await context.scheduler.runJob({
        name: ControlSubredditJob.ClassificationReversals,
        runAt: new Date(),
        data: {
            firstRun: true,
            usersToReverse: users,
            reversedTotal: 0,
            conversationId: message.conversationId,
        },
    });
}

export async function classificationReversalsJob (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const usersToReverse = event.data?.usersToReverse as string[] | undefined ?? [];
    const conversationId = event.data?.conversationId as string | undefined;
    let reversedTotal = event.data?.reversedTotal as number | undefined ?? 0;

    if (!conversationId) {
        throw new Error("Classification reversals job must be run with a conversation ID.");
    }

    if (usersToReverse.length === 0 && conversationId) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `✅ Completed reversals. A total of ${reversedTotal} ${pluralize("user", reversedTotal)} had their classifications reversed.`,
            isInternal: true,
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 10);

    while (usersToReverse.length > 0 && new Date() < runLimit) {
        const username = usersToReverse.shift();
        if (!username) {
            break;
        }

        const userStatus = await getUserStatus(username, context);
        if (userStatus?.userStatus !== UserStatus.Banned) {
            continue;
        }

        if (userStatus.trackingPostId) {
            await context.reddit.setPostFlair({
                subredditName: CONTROL_SUBREDDIT,
                postId: userStatus.trackingPostId,
                flairTemplateId: PostFlairTemplate.Declined,
            });
            await addToReversalsQueue(username, 7, context);
            reversedTotal++;
        }
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.ClassificationReversals,
        runAt: new Date(),
        data: {
            usersToReverse,
            conversationId,
            reversedTotal,
        },
    });
}

interface PostCreationQueueData {
    submitter?: string;
    hitReason?: string;
}

const schema: JSONSchemaType<PostCreationQueueData> = {
    type: "object",
    properties: {
        submitter: { type: "string", nullable: true },
        hitReason: { type: "string", nullable: true },
    },
    additionalProperties: false,
};

async function reverseQueue (message: ModmailMessage, context: TriggerContext) {
    if (!message.bodyMarkdown.startsWith("!reverse-postqueue {")) {
        return;
    }

    let data: PostCreationQueueData;
    try {
        data = JSON.parse(message.bodyMarkdown.replace("!reverse-postqueue ", "")) as PostCreationQueueData;
    } catch {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Invalid JSON format for the reverse-postqueue command.",
            isInternal: true,
        });
        return;
    }

    const ajv = new Ajv.default();
    const validate = ajv.compile(schema);
    if (!validate(data)) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: `❌ Invalid data for the reverse-postqueue command: ${ajv.errorsText(validate.errors)}`,
            isInternal: true,
        });
        return;
    }

    if (!data.submitter && !data.hitReason) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ You must specify at least a submitter or a hitReason to reverse entries in the post creation queue.",
            isInternal: true,
        });
        return;
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.PostCreationQueueReversals,
        runAt: new Date(),
        data: {
            firstRun: true,
            conversationId: message.conversationId,
            submitter: data.submitter ?? "",
            hitReason: data.hitReason ?? "",
            reversedTotal: 0,
        },
    });
}

const SUBMISSION_QUEUE = "submissionQueue";
const SUBMISSION_DETAILS = "submissionDetails";

export async function reversePostCreationQueue (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const conversationId = event.data?.conversationId as string | undefined;
    const submitterFilter = event.data?.submitter as string | undefined ?? "";
    const hitReasonFilter = event.data?.hitReason as string | undefined ?? "";
    let reversedTotal = event.data?.reversedTotal as number | undefined ?? 0;

    if (!conversationId) {
        throw new Error("Post creation queue reversals job must be run with a conversation ID.");
    }

    if (event.data?.firstRun) {
        console.log("Evaluator Reversals: Starting post creation queue reversals job.");
        const submissionQueue = await context.redis.zRange(SUBMISSION_QUEUE, 0, -1);
        await context.scheduler.runJob({
            name: ControlSubredditJob.PostCreationQueueReversals,
            runAt: new Date(),
            data: {
                firstRun: false,
                queueUsers: submissionQueue.map(entry => entry.member),
                conversationId,
                submitter: submitterFilter,
                hitReason: hitReasonFilter,
                reversedTotal,
            },
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 10);

    const queueUsers = event.data?.queueUsers as string[] | undefined ?? [];
    if (queueUsers.length === 0) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `✅ Completed post creation queue reversals. A total of ${reversedTotal} ${pluralize("user", reversedTotal)} had their entries removed from the post creation queue.`,
            isInternal: true,
        });
        return;
    }

    while (queueUsers.length > 0 && new Date() < runLimit) {
        const username = queueUsers.shift();
        if (!username) {
            break;
        }

        const submissionDetailsRaw = await context.redis.hGet(SUBMISSION_DETAILS, username);
        if (!submissionDetailsRaw) {
            continue;
        }

        if (submitterFilter) {
            const submissionDetails = JSON.parse(submissionDetailsRaw) as AsyncSubmission;
            if (submissionDetails.details.submitter !== submitterFilter) {
                continue;
            }
        }

        if (hitReasonFilter) {
            const evaluatorData = await getAccountInitialEvaluationResults(username, context);
            if (!evaluatorData.some(entry => entry.hitReason === hitReasonFilter)) {
                continue;
            }
        }

        // Reversible.
        const txn = await context.redis.watch();
        await txn.multi();
        await txn.zRem(SUBMISSION_QUEUE, [username]);
        await txn.hDel(SUBMISSION_DETAILS, [username]);
        await txn.exec();
        await deleteAccountInitialEvaluationResults(username, context);
        console.log(`Evaluator Reversals: Removed ${username} from the post creation queue.`);
        reversedTotal++;
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.PostCreationQueueReversals,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: false,
            queueUsers,
            conversationId,
            submitter: submitterFilter,
            hitReason: hitReasonFilter,
            reversedTotal,
        },
    });
}

export async function deleteRecordsForRemovedUsers (_: unknown, context: JobContext) {
    const runLimit = addSeconds(new Date(), 15);
    const removedUsers = await context.redis.zRange(REVERSED_USERS, 0, Date.now(), { by: "score" });
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

        const userStatus = await getUserStatus(username, context);
        if (userStatus?.userStatus !== UserStatus.Declined) {
            continue;
        }

        const txn = await context.redis.watch();
        await txn.multi();
        await updateAggregate(UserStatus.Declined, -1, txn);
        await txn.zRem(CLEANUP_LOG_KEY, [username]);
        await txn.exec();

        await deleteUserStatus(username, context);

        const post = await context.reddit.getPostById(userStatus.trackingPostId);
        await post.delete();
        deletedCount++;
    }

    console.log(`Delete Records: Processed ${processedCount} users, deleted ${deletedCount} users. ${removedUsers.length} users left in the queue.`);
    await context.redis.zRem(REVERSED_USERS, processedUsers);

    if (removedUsers.length > 0) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
            runAt: addMinutes(new Date(), 2),
        });
    }
}
