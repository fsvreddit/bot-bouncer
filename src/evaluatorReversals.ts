import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { deleteUserStatus, getActiveDataStore, getUserStatus, updateAggregate, UserDetails, UserStatus } from "./dataStore.js";
import { addSeconds, subDays } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob, PostFlairTemplate } from "./constants.js";
import { getAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import { CLEANUP_LOG_KEY } from "./cleanup.js";

const REVERSALS_QUEUE = "ReversalsQueue";
const SUBMISSION_REVERSAL_QUEUE = "submissionReversalQueue";

const REVERSED_USERS = "ReversedUsers";

enum ReversalPhase {
    ExistingBanned = "existingBanned",
    PostCreationQueue = "postCreationQueue",
}

const HIT_REASONS_TO_REVERSE: string[] = [
    // "\\(?:.\\){4,}",
    // "\\(\\[Hh\\].\\[Tt\\]\\)",
    // "\\(\\[Ss\\].\\[Nn\\].\\[Pp\\]|\\[Ss\\]\\[Nn\\].\\[Pp\\]|\\[Ss\\].\\[Nn\\]\\[Pp\\]\\)",
];

export async function evaluatorReversalsJob (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (HIT_REASONS_TO_REVERSE.length === 0) {
        return;
    }

    if (event.data?.firstRun) {
        const allActiveData = await getActiveDataStore(context);
        const cutoff = subDays(new Date(), 1).getTime();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const recentBannedUsers = Object.entries(allActiveData).filter(([_username, userData]) => {
            const parsed = JSON.parse(userData) as UserDetails;
            return parsed.userStatus === UserStatus.Banned && parsed.reportedAt && parsed.reportedAt > cutoff;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        }).map(([username, _userData]) => username);

        await context.redis.zAdd(REVERSALS_QUEUE, ...recentBannedUsers.map(username => ({ member: username, score: 0 })));

        const submissionQueue = await context.redis.zRange(SUBMISSION_QUEUE, 0, -1);
        await context.redis.zAdd(SUBMISSION_REVERSAL_QUEUE, ...submissionQueue);

        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReversals,
            runAt: new Date(),
            data: { phase: ReversalPhase.ExistingBanned },
        });

        console.log(`Evaluator Reversals: Queued ${recentBannedUsers.length} users for reversals checks.`);
        console.log(`Evaluator Reversals: Queued ${submissionQueue.length} submissions for reversals checks.`);

        return;
    }

    const phase = event.data?.phase as ReversalPhase | undefined;
    if (phase === ReversalPhase.ExistingBanned) {
        await reverseExistingBanned(context);
    } else if (phase === ReversalPhase.PostCreationQueue) {
        await reversePostCreationQueue(context);
    }
}

async function reverseExistingBanned (context: JobContext) {
    const runLimit = addSeconds(new Date(), 15);

    const queue = await context.redis.zRange(REVERSALS_QUEUE, 0, -1);

    let processedCount = 0;
    let reversedCount = 0;
    const processedUsers: string[] = [];

    while (queue.length > 0 && new Date() < runLimit) {
        const entry = queue.shift();
        if (!entry) {
            break;
        }

        const username = entry.member;

        const evaluatorData = await getAccountInitialEvaluationResults(username, context);

        if (evaluatorData.length > 0 && evaluatorData.every(entry => entry.hitReason && HIT_REASONS_TO_REVERSE.some(reason => entry.hitReason?.includes(reason)))) {
            // Reversible.
            console.log(`Evaluator Reversals: Reversing ${username} due to hit reasons.`);
            const userStatus = await getUserStatus(username, context);
            if (userStatus?.trackingPostId) {
                await context.reddit.setPostFlair({
                    subredditName: CONTROL_SUBREDDIT,
                    postId: userStatus.trackingPostId,
                    flairTemplateId: PostFlairTemplate.Declined,
                });
                await context.redis.zAdd(REVERSED_USERS, { member: username, score: new Date().getTime() });
                reversedCount++;
            }
        }
        processedCount++;
        processedUsers.push(username);
    }

    console.log(`Evaluator Reversals: Processed ${processedCount} users, reversed ${reversedCount} users. ${queue.length} users left in the queue.`);
    if (processedUsers.length > 0) {
        await context.redis.zRem(REVERSALS_QUEUE, processedUsers);
    }

    if (queue.length > 0) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReversals,
            runAt: new Date(),
            data: { phase: ReversalPhase.ExistingBanned },
        });
    } else {
        await context.redis.del(REVERSALS_QUEUE);
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReversals,
            runAt: new Date(),
            data: { phase: ReversalPhase.PostCreationQueue },
        });
    }
}

const SUBMISSION_QUEUE = "submissionQueue";
const SUBMISSION_DETAILS = "submissionDetails";

async function reversePostCreationQueue (context: JobContext) {
    const runLimit = addSeconds(new Date(), 15);

    let processedCount = 0;
    let reversedCount = 0;
    const processedUsers: string[] = [];

    const submissionReversalQueue = await context.redis.zRange(SUBMISSION_REVERSAL_QUEUE, 0, -1);
    while (submissionReversalQueue.length > 0 && new Date() < runLimit) {
        const entry = submissionReversalQueue.shift();
        if (!entry) {
            break;
        }

        const username = entry.member;
        const evaluatorData = await getAccountInitialEvaluationResults(username, context);

        if (evaluatorData.length > 0 && evaluatorData.every(entry => entry.hitReason && HIT_REASONS_TO_REVERSE.some(reason => entry.hitReason?.includes(reason)))) {
            // Reversible.
            await context.redis.zRem(SUBMISSION_QUEUE, [username]);
            await context.redis.hDel(SUBMISSION_DETAILS, [username]);
            console.log(`Evaluator Reversals: Removed ${username} from the post creation queue.`);
            reversedCount++;
        }

        processedCount++;
        processedUsers.push(username);
    }

    console.log(`Evaluator Reversals: Post Creation: Processed ${processedCount} users, reversed ${reversedCount} users. ${submissionReversalQueue.length} users left in the queue.`);
    if (processedUsers.length > 0) {
        await context.redis.zRem(SUBMISSION_REVERSAL_QUEUE, processedUsers);
    }
}

export async function deleteRecordsForRemovedUsers (_: unknown, context: JobContext) {
    const runLimit = addSeconds(new Date(), 15);
    const removedUsers = await context.redis.zRange(REVERSED_USERS, 0, subDays(new Date(), 7).getTime());
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
        await deleteUserStatus(username, userStatus.trackingPostId, txn);
        await txn.zRem(CLEANUP_LOG_KEY, [username]);
        await txn.exec();

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
