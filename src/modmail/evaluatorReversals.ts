import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext, WikiPagePermissionLevel } from "@devvit/public-api";
import { deleteUserStatus, getUserStatus, updateAggregate, UserStatus } from "../dataStore.js";
import { addDays, addMinutes, addSeconds, format } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob, PostFlairTemplate } from "../constants.js";
import { deleteAccountInitialEvaluationResults, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { CLEANUP_LOG_KEY } from "../cleanup.js";
import { ModmailMessage } from "./modmail.js";
import Ajv, { JSONSchemaType } from "ajv";
import { AsyncSubmission } from "../postCreation.js";
import pluralize from "pluralize";
import json2md from "json2md";
import { getConfigRevisionReceipt } from "../configRevisionReceipts.js";

const REVERSED_USERS = "ReversedUsers";

export async function addToReversalsQueue (username: string, days: number, context: TriggerContext) {
    const removalDate = addDays(new Date(), days).getTime();
    await context.redis.zAdd(REVERSED_USERS, { member: username, score: removalDate });
}

export async function removeUserFromReversalsQueue (username: string, context: TriggerContext) {
    const removedItems = await context.redis.zRem(REVERSED_USERS, [username]);
    if (removedItems > 0) {
        console.log(`Reversals Queue: Removed ${username} from reversals queue.`);
    }
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
        runAt: addSeconds(new Date(), 10),
        data: {
            firstRun: true,
            usersToReverse: users,
            reversedTotal: 0,
            conversationId: message.conversationId,
        },
    });

    await context.reddit.modMail.reply({
        conversationId: message.conversationId,
        body: `Scheduled reversal of classifications for ${users.length} ${pluralize("user", users.length)}. You will receive a confirmation message when the process is complete. Note - large reversal batches are done slowly to ensure that subreddits pick up on new classifications.`,
        isInternal: true,
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
    let reversedInBatch = 0;

    while (usersToReverse.length > 0 && reversedInBatch < 100 && new Date() < runLimit) {
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
                flairTemplateId: PostFlairTemplate.Organic,
            });
            await addToReversalsQueue(username, 7, context);

            reversedTotal++;
            reversedInBatch++;
        }
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.ClassificationReversals,
        runAt: addMinutes(new Date(), 1),
        data: {
            usersToReverse,
            conversationId,
            reversedTotal,
        },
    });
}

interface EmergencyCleanupData {
    code: string;
    confirm?: boolean;
    dryRun?: boolean;
}

const emergencyCleanupSchema: JSONSchemaType<EmergencyCleanupData> = {
    type: "object",
    properties: {
        code: { type: "string" },
        confirm: { type: "boolean", nullable: true },
        dryRun: { type: "boolean", nullable: true },
    },
    required: ["code"],
    additionalProperties: false,
};

function getEmergencyCleanupMatchesKey (cleanupId: string): string {
    return `emergencyCleanupMatches:${cleanupId}`;
}

function getEmergencyCleanupRevisionText (receipt: Awaited<ReturnType<typeof getConfigRevisionReceipt>>): string {
    if (!receipt) {
        return "Unknown";
    }

    if (receipt.appliesToAllEvaluators) {
        return "Shared evaluator variables";
    }

    if (receipt.changedEvaluatorNames.length > 0) {
        return receipt.changedEvaluatorNames.join(", ");
    }

    return "Unknown evaluator variables";
}

export async function handleEmergencyCleanupCommand (message: ModmailMessage, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Emergency cleanup commands can only be handled in the control subreddit.");
    }

    if (!message.bodyMarkdown.startsWith("!emergency-cleanup {")) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Invalid command format. Use `!emergency-cleanup {\"code\":\"REVISION-CODE\",\"confirm\":true}` or `!emergency-cleanup {\"code\":\"REVISION-CODE\",\"dryRun\":true}`.",
            isInternal: true,
        });
        return;
    }

    let data: EmergencyCleanupData;
    try {
        data = JSON.parse(message.bodyMarkdown.replace("!emergency-cleanup ", "")) as EmergencyCleanupData;
    } catch {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Invalid JSON format for the emergency-cleanup command.",
            isInternal: true,
        });
        return;
    }

    const ajv = new Ajv.default();
    const validate = ajv.compile(emergencyCleanupSchema);
    if (!validate(data)) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: `❌ Invalid data for the emergency-cleanup command: ${ajv.errorsText(validate.errors)}`,
            isInternal: true,
        });
        return;
    }

    if (!data.confirm && !data.dryRun) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ Emergency cleanup requires either `confirm: true` or `dryRun: true`. No changes were made.",
            isInternal: true,
        });
        return;
    }

    const receipt = await getConfigRevisionReceipt(data.code, context);
    if (!receipt) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ The revision code was not found. It may be invalid or expired.",
            isInternal: true,
        });
        return;
    }

    const cleanupId = Date.now().toString();
    await context.scheduler.runJob({
        name: ControlSubredditJob.EmergencyConfigCleanup,
        runAt: new Date(),
        data: {
            firstRun: true,
            cleanupId,
            code: data.code,
            dryRun: data.dryRun === true,
            conversationId: message.conversationId,
            runBy: message.messageAuthor,
            matchedTotal: 0,
            removedTotal: 0,
            invalidTotal: 0,
        },
    });

    await context.reddit.modMail.reply({
        conversationId: message.conversationId,
        body: `${data.dryRun ? "Dry-run" : "Emergency cleanup"} scheduled for revision code ${data.code}. Bot Bouncer will reply with the extraction and cleanup report when complete.`,
        isInternal: true,
    });
}

export async function emergencyConfigCleanupJob (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const conversationId = event.data?.conversationId as string | undefined;
    const cleanupId = event.data?.cleanupId as string | undefined;
    const code = event.data?.code as string | undefined;
    const dryRun = event.data?.dryRun as boolean | undefined ?? false;
    const runBy = event.data?.runBy as string | undefined ?? "unknown";
    let matchedTotal = event.data?.matchedTotal as number | undefined ?? 0;
    let removedTotal = event.data?.removedTotal as number | undefined ?? 0;
    let invalidTotal = event.data?.invalidTotal as number | undefined ?? 0;

    if (!conversationId || !cleanupId || !code) {
        throw new Error("Emergency config cleanup job must be run with conversationId, cleanupId, and code.");
    }

    const receipt = await getConfigRevisionReceipt(code, context);
    if (!receipt) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `❌ Emergency cleanup failed because revision code ${code} was not found.`,
            isInternal: true,
        });
        return;
    }

    if (event.data?.firstRun) {
        console.log(`Emergency Cleanup: Starting ${dryRun ? "dry-run" : "cleanup"} for config revision ${code}.`);
        const submissionQueue = await context.redis.zRange(SUBMISSION_QUEUE, 0, -1);
        await context.redis.del(getEmergencyCleanupMatchesKey(cleanupId));
        await context.scheduler.runJob({
            name: ControlSubredditJob.EmergencyConfigCleanup,
            runAt: new Date(),
            data: {
                firstRun: false,
                cleanupId,
                code,
                dryRun,
                queueUsers: submissionQueue.map(entry => entry.member),
                conversationId,
                runBy,
                matchedTotal,
                removedTotal,
                invalidTotal,
            },
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 10);
    const queueUsers = event.data?.queueUsers as string[] | undefined ?? [];

    if (queueUsers.length === 0) {
        const wikiLink = await writeEmergencyCleanupExtract(cleanupId, code, receipt, conversationId, dryRun, runBy, context);
        await context.redis.del(getEmergencyCleanupMatchesKey(cleanupId));

        const body: string[] = [
            dryRun ? "✅ Emergency cleanup dry-run completed." : "✅ Emergency cleanup completed.",
            "",
            `Revision code: ${code}`,
            `Revision saved: ${new Date(receipt.createdAt).toISOString()}`,
            `Changed evaluator context: ${getEmergencyCleanupRevisionText(receipt)}`,
            `Cleanup run by: u/${runBy}`,
            "",
            `Matching queue entries: ${matchedTotal.toLocaleString()}`,
            dryRun ? "Queue entries removed: 0 (dry run)" : `Queue entries removed: ${removedTotal.toLocaleString()}`,
        ];

        if (invalidTotal > 0) {
            body.push(`Queue entries skipped due to unreadable details: ${invalidTotal.toLocaleString()}`);
        }

        if (wikiLink) {
            body.push("");
            body.push(`Data extraction saved before cleanup: ${wikiLink}`);
        } else {
            body.push("");
            body.push("No matching queue entries were found, so no extraction page was written.");
        }

        if (dryRun && matchedTotal > 0) {
            body.push("");
            body.push("To run the cleanup, use:");
            body.push(`\`!emergency-cleanup {"code":"${code}","confirm":true}\``);
        }

        await context.reddit.modMail.reply({
            conversationId,
            body: body.join("\n"),
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

        let submissionDetails: AsyncSubmission;
        try {
            submissionDetails = JSON.parse(submissionDetailsRaw) as AsyncSubmission;
        } catch {
            invalidTotal++;
            continue;
        }

        if (submissionDetails.configRevisionHit?.revisionCode !== code) {
            continue;
        }

        matchedTotal++;
        await context.redis.hSet(getEmergencyCleanupMatchesKey(cleanupId), { [username]: submissionDetailsRaw });
        await context.redis.expire(getEmergencyCleanupMatchesKey(cleanupId), 60 * 60);

        if (!dryRun) {
            const txn = await context.redis.watch();
            await txn.multi();
            await txn.zRem(SUBMISSION_QUEUE, [username]);
            await txn.hDel(SUBMISSION_DETAILS, [username]);
            await txn.exec();
            await deleteAccountInitialEvaluationResults(username, context);
            removedTotal++;
            console.log(`Emergency Cleanup: Removed ${username} from the post creation queue for config revision ${code}.`);
        }
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.EmergencyConfigCleanup,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: false,
            cleanupId,
            code,
            dryRun,
            queueUsers,
            conversationId,
            runBy,
            matchedTotal,
            removedTotal,
            invalidTotal,
        },
    });
}

async function writeEmergencyCleanupExtract (
    cleanupId: string,
    code: string,
    receipt: NonNullable<Awaited<ReturnType<typeof getConfigRevisionReceipt>>>,
    conversationId: string,
    dryRun: boolean,
    runBy: string,
    context: JobContext,
): Promise<string | undefined> {
    const rawData = await context.redis.hGetAll(getEmergencyCleanupMatchesKey(cleanupId));
    const entries = Object.entries(rawData)
        .map(([username, value]) => ({ username, submission: JSON.parse(value) as AsyncSubmission }))
        .sort((a, b) => a.username.localeCompare(b.username));

    if (entries.length === 0) {
        return;
    }

    if (entries.length > 5000) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `Emergency cleanup matched ${entries.length.toLocaleString()} queue entries. This exceeds the 5,000-user wiki extraction limit, so the detailed table was not written.`,
            isInternal: true,
        });
        return;
    }

    const headers = ["User", "Queued At", "Submitter", "Status", "Matched Evaluator", "Target Subreddit", "Target ID"];
    const rows = entries.map((entry) => {
        const queueTime = entry.submission.queueTime ?? entry.submission.details.reportedAt;
        const targetId = entry.submission.configRevisionHit?.targetId ?? "";
        return [
            `[${entry.username}](https://www.reddit.com/user/${entry.username})`,
            queueTime ? format(new Date(queueTime), "yyyy-MM-dd HH:mm") : "",
            entry.submission.details.submitter ?? entry.submission.submitter ?? "",
            entry.submission.details.userStatus,
            entry.submission.configRevisionHit?.evaluatorName ?? "",
            entry.submission.configRevisionHit?.subreddit ? `/r/${entry.submission.configRevisionHit.subreddit}` : "",
            targetId ? `https://redd.it/${targetId.substring(3)}` : "",
        ];
    });

    const content = json2md([
        { h1: "Emergency cleanup data extraction" },
        { p: `Revision code: ${code}` },
        { p: `Revision saved: ${new Date(receipt.createdAt).toISOString()}` },
        { p: `Changed evaluator context: ${getEmergencyCleanupRevisionText(receipt)}` },
        { p: `Cleanup mode: ${dryRun ? "dry run" : "confirmed cleanup"}` },
        { p: `Cleanup run by: u/${runBy}` },
        { p: `Matched queued users: ${entries.length.toLocaleString()}` },
        { table: { headers, rows } },
    ]);

    const subredditName = context.subredditName ?? CONTROL_SUBREDDIT;
    const wikiPageName = "emergency-cleanup";
    let wikiPageExists = true;
    try {
        await context.reddit.getWikiPage(subredditName, wikiPageName);
    } catch {
        wikiPageExists = false;
    }

    const result = await context.reddit.updateWikiPage({
        subredditName,
        page: wikiPageName,
        content,
    });

    if (!wikiPageExists) {
        await context.reddit.updateWikiPageSettings({
            subredditName,
            page: wikiPageName,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
            listed: true,
        });
    }

    return `https://www.reddit.com/r/${subredditName}/wiki/${wikiPageName}?v=${result.revisionId}`;
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

    if (!data.submitter && !data.hitReason && !data.hitReasonRegex) {
        await context.reddit.modMail.reply({
            conversationId: message.conversationId,
            body: "❌ You must specify at least a submitter, hitReason, or hitReasonRegex to reverse entries in the post creation queue.",
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
            hitReasonRegex: data.hitReasonRegex ?? "",
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
    const hitReasonRegexFilter = event.data?.hitReasonRegex as string | undefined ?? "";

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
        const remainingCount = await context.redis.zCard(SUBMISSION_QUEUE);
        const message: json2md.DataObject[] = [
            { p: `✅ Completed post creation queue reversals. A total of ${reversedTotal} ${pluralize("user", reversedTotal)} had their entries removed from the post creation queue.` },
            { p: `There are ${remainingCount} ${pluralize("user", remainingCount)} remaining in the post creation queue.` },
        ];
        await context.reddit.modMail.reply({
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

        if (hitReasonFilter || hitReasonRegexFilter) {
            const evaluatorData = await getAccountInitialEvaluationResults(username, context);
            if (!evaluatorData.some((entry) => {
                if (!entry.hitReason) {
                    return false;
                }

                let hitReason: string;
                if (typeof entry.hitReason === "string") {
                    hitReason = entry.hitReason;
                } else {
                    hitReason = entry.hitReason.reason;
                }
                return hitReason.includes(hitReasonFilter) || (hitReasonRegexFilter && new RegExp(hitReasonRegexFilter).test(hitReason));
            })) {
                continue;
            }
        }

        // Reversible.
        await context.redis.zRem(SUBMISSION_QUEUE, [username]);
        await context.redis.hDel(SUBMISSION_DETAILS, [username]);
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
        if (userStatus?.userStatus !== UserStatus.Organic) {
            continue;
        }

        await updateAggregate(userStatus.userStatus, -1, context.redis);
        await context.redis.zRem(CLEANUP_LOG_KEY, [username]);

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
            runAt: addSeconds(new Date(), 5),
        });
    }
}
