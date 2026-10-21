import { context, Post, reddit, redis, scheduler, ZMember } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { CONTROL_SUBREDDIT, INTERNAL_BOT, PostFlairTemplate } from "../constants";
import { UserExtended } from "@fsvreddit/fsv-devvit-web-helpers";
import { getUserStatus, setUserStatus, storeInitialAccountProperties, UserDetails } from "../dataStore";
import { addDays, addHours, addMinutes, addSeconds, differenceInMinutes, format } from "date-fns";
import { isUserSubmitterOrMod } from "../cleanup";
import { ControlSubredditJob } from "../schedulerJobs";
import { getControlSubSettings } from "../controlSubSettings";
import { formatTimeSince, isBannedWithCache, sendMessageToWebhook, updateWebhookMessage } from "../utility";
import pluralize from "pluralize";
import { queueSendFeedback, recordBotPostCreated } from ".";
import { EvaluateUserJobData, StoreDefinedHandlesDataJobData } from "../../tasks";

export const statusToFlair: Record<UserStatus, PostFlairTemplate> = {
    [UserStatus.Pending]: PostFlairTemplate.Pending,
    [UserStatus.Banned]: PostFlairTemplate.Banned,
    [UserStatus.Service]: PostFlairTemplate.Service,
    [UserStatus.Organic]: PostFlairTemplate.Organic,
    [UserStatus.Purged]: PostFlairTemplate.Purged,
    [UserStatus.Retired]: PostFlairTemplate.Retired,
    [UserStatus.Inactive]: PostFlairTemplate.Inactive,
};

const SUBMISSION_QUEUE = "submissionQueue";
const SUBMISSION_DETAILS = "submissionDetails";

export interface AsyncSubmission {
    user: UserExtended;
    submitter?: string;
    details: UserDetails;
    commentToAdd?: string;
    removeComment?: boolean;
    callback?: {
        postId: string;
        comment: string;
    };
    immediate: boolean;
    reportContext?: string;
    evaluatorsChecked: boolean;
    queueTime?: number;
}

export async function isUserAlreadyQueued (username: string): Promise<boolean> {
    return await redis.zScore(SUBMISSION_QUEUE, username).then(score => score !== undefined);
}

export async function promotePositionInQueue (username: string) {
    const existingScore = await redis.zScore(SUBMISSION_QUEUE, username);
    if (existingScore !== undefined) {
        await redis.zAdd(SUBMISSION_QUEUE, { member: username, score: Date.now() / 1000 });
        console.log(`Post Creation: Promoted ${username}'s position in the queue.`);
    }
}

async function addReportContextComment (submission: AsyncSubmission, post: Post) {
    if (!submission.commentToAdd || submission.commentToAdd.trim().length === 0) {
        return;
    }

    const newComment = await post.addComment({
        text: submission.commentToAdd,
    });

    await newComment.distinguish();
    if (submission.removeComment) {
        await newComment.remove();
    }
}

async function addCallbackComment (submission: AsyncSubmission, post: Post) {
    if (!submission.callback) {
        return;
    }

    const callbackPost = await reddit.getPostById(submission.callback.postId as T3);
    if (callbackPost.authorName !== "[deleted]") {
        const commentText = submission.callback.comment.replace("{{permalink}}", post.permalink);
        const newComment = await callbackPost.addComment({ text: commentText });
        await newComment.distinguish(true);
        await redis.set(`callbackCommentPosted:${submission.user.username}`, newComment.id, { expiration: addDays(new Date(), 7) });
    }
}

async function createNewSubmission (submission: AsyncSubmission) {
    if (submission.user.username.endsWith("-ModTeam")) {
        console.log(`Post Creation: Skipping post creation for ${submission.user.username} as it is a ModTeam account.`);
        return;
    }

    const currentStatus = await getUserStatus(submission.user.username);
    if (currentStatus) {
        console.log(`Post Creation: User ${submission.user.username} already has a status of ${currentStatus.userStatus}.`);
        return;
    }

    let forceManualReview = false;
    const forceManualReviewReasons: string[] = [];
    if (submission.user.isGold) {
        forceManualReview = true;
        forceManualReviewReasons.push("Reddit Premium");
    }

    if (submission.user.isAdmin) {
        forceManualReview = true;
        forceManualReviewReasons.push("Reddit Admin");
    }

    if (submission.user.linkKarma + submission.user.commentKarma > 100000) {
        forceManualReview = true;
        forceManualReviewReasons.push("High Karma");
    }

    // Check to see if the user being submitted is a Bot Bouncer submitter.
    const userIsSubmitterOrMod = await isUserSubmitterOrMod(submission.user.username);
    if (userIsSubmitterOrMod) {
        forceManualReview = true;
        forceManualReviewReasons.push("Bot Submitter");
        console.log(`Post Creation: User ${submission.user.username} is a submitter or mod, forcing manual review.`);
    }

    if (forceManualReview) {
        submission.details.userStatus = UserStatus.Pending;
    }

    const postCreationLockKey = `postCreationLock:${submission.user.username}`;
    if (await redis.exists(postCreationLockKey)) {
        console.log(`Post Creation: User ${submission.user.username}'s lock already set.`);
        return;
    }
    await redis.set(postCreationLockKey, "locked", { expiration: addHours(new Date(), 1) });

    const newPost = await reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${submission.user.username}`,
        url: `https://www.reddit.com/user/${submission.user.username}`,
        flairId: statusToFlair[submission.details.userStatus],
        nsfw: submission.user.nsfw,
    });

    submission.details.trackingPostId = newPost.id;
    submission.details.reportedAt = Date.now();
    submission.details.lastUpdate = Date.now();

    await setUserStatus(submission.user.username, submission.details);

    const promises: Promise<unknown>[] = [
        recordBotPostCreated(newPost),
        addReportContextComment(submission, newPost),
        addCallbackComment(submission, newPost),
        storeInitialAccountProperties(submission.user.username),
    ];

    if (submission.details.userStatus === UserStatus.Pending || !submission.evaluatorsChecked) {
        promises.push(scheduler.runJob<EvaluateUserJobData>({
            name: ControlSubredditJob.EvaluateUser,
            runAt: addSeconds(new Date(), 5),
            data: {
                username: submission.user.username,
                postId: newPost.id,
                forceManualReview,
                forceManualReviewReasons,
                jobGuid: crypto.randomUUID(),
            },
        }));
    }

    if (submission.details.userStatus !== UserStatus.Pending) {
        promises.push(queueSendFeedback(submission.user.username));
    }

    if (submission.details.userStatus === UserStatus.Banned) {
        promises.push(scheduler.runJob<StoreDefinedHandlesDataJobData>({
            name: ControlSubredditJob.DefinedHandlesPostStore,
            runAt: addSeconds(new Date(), 1),
            data: { username: submission.user.username, jobGuid: crypto.randomUUID() },
        }));
    }

    console.log(`Post Creation: Created new post for ${submission.user.username} with status ${submission.details.userStatus}.`);

    if (submission.reportContext && submission.submitter && submission.reportContext.trim().length > 0) {
        let modNoteText = `u/${submission.submitter} reported: ${submission.reportContext.trim()}`;
        if (modNoteText.length > 250) {
            modNoteText = modNoteText.substring(0, 247) + "...";
        }

        promises.push(reddit.addModNote({
            user: submission.user.username,
            subreddit: CONTROL_SUBREDDIT,
            note: modNoteText,
        }));
    }

    const results = await Promise.allSettled(promises);

    const rejectedPromises = results.filter(result => result.status === "rejected");

    if (rejectedPromises.length > 0) {
        console.error(`Post Creation: One or more non-critical post creation tasks failed for ${submission.user.username}.`, rejectedPromises);
    }
}

export enum PostCreationQueueResult {
    Queued = "queued",
    AlreadyInQueue = "alreadyInQueue",
    AlreadyInDatabase = "alreadyInDatabase",
    Error = "error",
}

export async function queuePostCreation (submissions: AsyncSubmission[]): Promise<PostCreationQueueResult[]> {
    const results: PostCreationQueueResult[] = [];

    const submissionsToAdd: Record<string, string> = {};
    const queueEntriesToAdd: ZMember[] = [];

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowNewSubmissions) {
        console.log("Post Creation: Post creation queue is disabled in control sub settings.");
        return [PostCreationQueueResult.Error];
    }

    const bannedSubmitters = new Set(controlSubSettings.reporterBlacklist.map(entry => entry.toLowerCase()));

    for (const submission of submissions) {
        const currentStatus = await getUserStatus(submission.user.username);
        if (currentStatus) {
            console.log(`Post Creation: User ${submission.user.username} already has a status of ${currentStatus.userStatus}.`);
            results.push(PostCreationQueueResult.AlreadyInDatabase);
            continue;
        }

        if (submission.submitter && await isBannedWithCache(submission.submitter)) {
            console.log(`Post Creation: Submitter ${submission.submitter} is banned from the control subreddit.`);
            results.push(PostCreationQueueResult.Error);
            continue;
        }

        if (submission.submitter && bannedSubmitters.has(submission.submitter.toLowerCase())) {
            console.log(`Post Creation: Submitter ${submission.submitter} is blacklisted from submitting.`);
            results.push(PostCreationQueueResult.Error);
            continue;
        }

        let score = submission.immediate ? new Date().getTime() / 1000 : new Date().getTime();

        // Hacky workaround to promote private bot submissions
        if (submission.details.submitter?.startsWith(`${context.appSlug}-`) && submission.details.submitter !== INTERNAL_BOT) {
            score /= 2;
        }

        const alreadyInQueue = await isUserAlreadyQueued(submission.user.username);
        if (alreadyInQueue) {
            console.log(`Post Creation: User ${submission.user.username} is already in the queue.`);
            if (submission.immediate) {
                // If the new submission is immediate, we need to update the score to be sooner.
                await redis.zAdd(SUBMISSION_QUEUE, { member: submission.user.username, score });
                console.log(`Post Creation: Updated ${submission.user.username}'s position in the queue to be sooner.`);
            }
            results.push(PostCreationQueueResult.AlreadyInQueue);
            continue;
        }

        submissionsToAdd[submission.user.username] = JSON.stringify(submission);
        queueEntriesToAdd.push({ member: submission.user.username, score });
        results.push(PostCreationQueueResult.Queued);
    }

    if (Object.keys(submissionsToAdd).length === 0) {
        return results;
    }

    const txn = await redis.watch();
    await txn.multi();

    try {
        await txn.hSet(SUBMISSION_DETAILS, submissionsToAdd);
        await txn.zAdd(SUBMISSION_QUEUE, ...queueEntriesToAdd);
        await txn.exec();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Post Creation: Error queueing posts.`, message);
        await txn.discard();
    }

    return results;
}

export async function processQueuedSubmission () {
    const queuedSubmissions = await redis.zRange(SUBMISSION_QUEUE, 0, -1);
    if (queuedSubmissions.length === 0) {
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.postCreationQueueProcessingEnabled) {
        console.log("Post Creation: Post creation queue processing is disabled in control sub settings.");
        return;
    }

    let usernameToProcess: string | undefined;

    // Every two minutes, process an entry queued from a bulk submission so they don't end up lingering.
    const bulkProcessedKey = "postCreationBulkProcessedRecently";
    if (!await redis.exists(bulkProcessedKey)) {
        const firstBulkSubmission = queuedSubmissions.find(item => item.score > new Date().getTime() / 1.5);
        if (firstBulkSubmission) {
            console.log(`Post Creation: Processing a bulk submission for user ${firstBulkSubmission.member} from ${format(new Date(firstBulkSubmission.score), "yyyy-MM-dd hh:mm")}.`);
            usernameToProcess = firstBulkSubmission.member;
            await redis.set(bulkProcessedKey, Date.now().toString(), { expiration: addMinutes(new Date(), 2) });
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    usernameToProcess ??= queuedSubmissions[0]!.member;

    const submissionDetails = await redis.hGet(SUBMISSION_DETAILS, usernameToProcess);
    if (!submissionDetails) {
        console.error(`Post Creation: No details found in redis for user ${usernameToProcess}.`);
        await redis.zRem(SUBMISSION_QUEUE, [usernameToProcess]);
        return;
    }

    const cooldownKey = "postCreationCooldown";
    if (await redis.exists(cooldownKey)) {
        console.log("Post Creation: Post creation is on cooldown. Skipping this run.");
        return;
    }

    await redis.set(cooldownKey, Date.now().toString(), { expiration: addMinutes(new Date(), 2) });

    const txn = await redis.watch();
    await txn.multi();
    await txn.zRem(SUBMISSION_QUEUE, [usernameToProcess]);
    await txn.hDel(SUBMISSION_DETAILS, [usernameToProcess]);
    await txn.exec();

    await createNewSubmission(JSON.parse(submissionDetails) as AsyncSubmission);

    await redis.del(cooldownKey);

    const remainingItemsInQueue = queuedSubmissions.length - 1;
    const firstItemNonUrgent = queuedSubmissions.find(item => item.score > new Date().getTime() / 5);

    if (remainingItemsInQueue > 0) {
        let message = `Post Creation: ${remainingItemsInQueue} ${pluralize("submission", remainingItemsInQueue)} still in the queue.`;
        if (firstItemNonUrgent) {
            const firstItemNonUrgentTime = firstItemNonUrgent.score < Date.now() / 1.5 ? new Date(firstItemNonUrgent.score * 2) : new Date(firstItemNonUrgent.score);
            if (differenceInMinutes(new Date(), new Date(firstItemNonUrgentTime)) >= 1) {
                message += ` Backlog: ${formatTimeSince(firstItemNonUrgentTime)}`;
            }
        }
        console.log(message);
    }

    const alertKey = "postCreationQueueAlertSent";
    const maxQueueLengthKey = "postCreationQueueAlertMaxQueueLength";

    if (controlSubSettings.backlogWebhook) {
        if (remainingItemsInQueue > (controlSubSettings.postCreationQueueAlertLevel ?? 100) && !await redis.exists(alertKey)) {
            const messageId = await sendMessageToWebhook(controlSubSettings.backlogWebhook, `⚠️ Post creation queue is backlogged. There are currently ${remainingItemsInQueue} ${pluralize("submission", remainingItemsInQueue)} waiting to be processed.`);
            if (messageId) {
                await redis.set(alertKey, messageId);
                await redis.set(maxQueueLengthKey, remainingItemsInQueue.toString());
            }
        } else {
            const messageId = await redis.get(alertKey);
            const maxQueueLengthVal = await redis.get(maxQueueLengthKey);
            let maxQueueLength = maxQueueLengthVal ? parseInt(maxQueueLengthVal, 10) : 0;

            if (remainingItemsInQueue > 0 && messageId) {
                if (remainingItemsInQueue > maxQueueLength) {
                    maxQueueLength = remainingItemsInQueue;
                    await redis.set(maxQueueLengthKey, maxQueueLength.toString());
                }

                let message = `⚠️ Post creation queue is backlogged. As at <t:${Math.round(Date.now() / 1000)}:t> there ${pluralize("is", remainingItemsInQueue)} currently ${remainingItemsInQueue.toLocaleString()} ${pluralize("submission", remainingItemsInQueue)} waiting to be processed. (Max observed: ${maxQueueLength.toLocaleString()}).`;
                if (firstItemNonUrgent) {
                    const firstItemNonUrgentTime = firstItemNonUrgent.score < Date.now() / 1.5 ? new Date(firstItemNonUrgent.score * 2) : new Date(firstItemNonUrgent.score);
                    message += `\n\nFirst non-urgent item: <t:${Math.round(firstItemNonUrgentTime.getTime() / 1000)}:R>.`;
                }

                const immediateCount = queuedSubmissions.filter(item => item.score <= new Date().getTime() / 5).length;
                if (immediateCount > 0) {
                    message += ` There ${pluralize("is", immediateCount)} ${immediateCount.toLocaleString()} immediate ${pluralize("submission", immediateCount)} in the queue.`;
                }

                await updateWebhookMessage(
                    controlSubSettings.backlogWebhook,
                    messageId,
                    message,
                );
            } else if (remainingItemsInQueue === 0) {
                if (messageId) {
                    await updateWebhookMessage(controlSubSettings.backlogWebhook, messageId, `✅ Post creation queue was cleared at <t:${Math.round(Date.now() / 1000)}:f>. The maximum queue length observed was ${maxQueueLength}.`);
                }
                await redis.del(alertKey, maxQueueLengthKey);
            }
        }
    }
}
