import { JobContext, TriggerContext, ZMember } from "@devvit/public-api";
import { getUserStatus, setUserStatus, storeInitialAccountProperties, UserDetails, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob, INTERNAL_BOT, PostFlairTemplate } from "./constants.js";
import { UserExtended } from "@fsvreddit/fsv-devvit-helpers";
import { addDays, addHours, addMinutes, addSeconds, subWeeks } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import pluralize from "pluralize";
import { queueSendFeedback } from "./submissionFeedback.js";
import { formatTimeSince, isBannedWithCache, sendMessageToWebhook, updateWebhookMessage } from "./utility.js";
import { isUserSubmitterOrMod } from "./cleanup.js";
import { recordBotPostCreated } from "./scheduler/botPostMonitor.js";

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

export async function isUserAlreadyQueued (username: string, context: JobContext): Promise<boolean> {
    return await context.redis.zScore(SUBMISSION_QUEUE, username).then(score => score !== undefined);
}

export async function promotePositionInQueue (username: string, context: JobContext) {
    const existingScore = await context.redis.zScore(SUBMISSION_QUEUE, username);
    if (existingScore !== undefined) {
        await context.redis.zAdd(SUBMISSION_QUEUE, { member: username, score: Date.now() / 1000 });
        console.log(`Post Creation: Promoted ${username}'s position in the queue.`);
    }
}

async function createNewSubmission (submission: AsyncSubmission, context: TriggerContext) {
    if (submission.user.username.endsWith("-ModTeam")) {
        console.log(`Post Creation: Skipping post creation for ${submission.user.username} as it is a ModTeam account.`);
        return;
    }

    const currentStatus = await getUserStatus(submission.user.username, context);
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
    const userIsSubmitterOrMod = await isUserSubmitterOrMod(submission.user.username, context);
    if (userIsSubmitterOrMod) {
        forceManualReview = true;
        forceManualReviewReasons.push("Bot Submitter");
        console.log(`Post Creation: User ${submission.user.username} is a submitter or mod, forcing manual review.`);
    }

    if (forceManualReview) {
        submission.details.userStatus = UserStatus.Pending;
    }

    const postCreationLockKey = `postCreationLock:${submission.user.username}`;
    if (await context.redis.exists(postCreationLockKey)) {
        console.log(`Post Creation: User ${submission.user.username}'s lock already set.`);
        return;
    }
    await context.redis.set(postCreationLockKey, "locked", { expiration: addHours(new Date(), 1) });

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${submission.user.username}`,
        url: `https://www.reddit.com/user/${submission.user.username}`,
        flairId: statusToFlair[submission.details.userStatus],
        nsfw: submission.user.nsfw,
    });

    try {
        await recordBotPostCreated(newPost, context);
    } catch (error) {
        console.error("Bot Post Monitor: Error recording new bot post.", error);
    }

    submission.details.trackingPostId = newPost.id;
    submission.details.reportedAt = Date.now();
    submission.details.lastUpdate = Date.now();

    await setUserStatus(submission.user.username, submission.details, context);

    if (submission.commentToAdd) {
        const newComment = await newPost.addComment({
            text: submission.commentToAdd,
        });
        await newComment.distinguish();
        if (submission.removeComment) {
            await newComment.remove();
        }
    }

    if (submission.details.userStatus === UserStatus.Pending || !submission.evaluatorsChecked) {
        const controlSubSettings = await getControlSubSettings(context);
        if (!controlSubSettings.evaluationDisabled) {
            await context.scheduler.runJob({
                name: ControlSubredditJob.EvaluateUser,
                runAt: addSeconds(new Date(), 5),
                data: {
                    username: submission.user.username,
                    postId: newPost.id,
                    forceManualReview,
                    forceManualReviewReasons,
                    jobGuid: crypto.randomUUID(),
                },
            });
        }
    }

    if (submission.callback) {
        const callbackPost = await context.reddit.getPostById(submission.callback.postId);
        if (callbackPost.authorName !== "[deleted]") {
            const commentText = submission.callback.comment.replace("{{permalink}}", newPost.permalink);
            const newComment = await callbackPost.addComment({ text: commentText });
            await newComment.distinguish(true);
            await context.redis.set(`callbackCommentPosted:${submission.user.username}`, newComment.id, { expiration: addDays(new Date(), 7) });
        }
    }

    try {
        await storeInitialAccountProperties(submission.user.username, context);
    } catch (error) {
        console.error(`Post Creation: Error storing initial account properties for user ${submission.user.username}.`, error);
    }

    if (submission.details.userStatus !== UserStatus.Pending) {
        await queueSendFeedback(submission.user.username, context);
    }

    if (submission.details.userStatus === UserStatus.Banned) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.DefinedHandlesPostStore,
            runAt: addSeconds(new Date(), 1),
            data: { username: submission.user.username, jobGuid: crypto.randomUUID() },
        });
    }

    console.log(`Post Creation: Created new post for ${submission.user.username} with status ${submission.details.userStatus}.`);

    if (submission.reportContext && submission.submitter && submission.reportContext.trim().length > 0) {
        let modNoteText = `u/${submission.submitter} reported: ${submission.reportContext.trim()}`;
        if (modNoteText.length > 250) {
            modNoteText = modNoteText.substring(0, 247) + "...";
        }
        await context.reddit.addModNote({
            user: submission.user.username,
            subreddit: CONTROL_SUBREDDIT,
            note: modNoteText,
        });
    }
}

export enum PostCreationQueueResult {
    Queued = "queued",
    AlreadyInQueue = "alreadyInQueue",
    AlreadyInDatabase = "alreadyInDatabase",
    Error = "error",
}

export async function queuePostCreation (submissions: AsyncSubmission[], context: TriggerContext): Promise<PostCreationQueueResult[]> {
    const results: PostCreationQueueResult[] = [];

    const submissionsToAdd: Record<string, string> = {};
    const queueEntriesToAdd: ZMember[] = [];

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.allowNewSubmissions) {
        console.log("Post Creation: Post creation queue is disabled in control sub settings.");
        return [PostCreationQueueResult.Error];
    }

    for (const submission of submissions) {
        const currentStatus = await getUserStatus(submission.user.username, context);
        if (currentStatus) {
            console.log(`Post Creation: User ${submission.user.username} already has a status of ${currentStatus.userStatus}.`);
            results.push(PostCreationQueueResult.AlreadyInDatabase);
            continue;
        }

        if (submission.submitter && await isBannedWithCache(submission.submitter, context)) {
            console.log(`Post Creation: Submitter ${submission.submitter} is banned from the control subreddit.`);
            results.push(PostCreationQueueResult.Error);
            continue;
        }

        let score = submission.immediate ? new Date().getTime() / 1000 : new Date().getTime();

        // Hacky workaround to promote private bot submissions
        if (submission.details.submitter?.startsWith(`${context.appSlug}-`) && submission.details.submitter !== INTERNAL_BOT) {
            score /= 2;
        }

        const alreadyInQueue = await isUserAlreadyQueued(submission.user.username, context);
        if (alreadyInQueue) {
            console.log(`Post Creation: User ${submission.user.username} is already in the queue.`);
            if (submission.immediate) {
                // If the new submission is immediate, we need to update the score to be sooner.
                await context.redis.zAdd(SUBMISSION_QUEUE, { member: submission.user.username, score });
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

    const txn = await context.redis.watch();
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

export async function processQueuedSubmission (context: JobContext) {
    const queuedSubmissions = await context.redis.zRange(SUBMISSION_QUEUE, 0, -1);
    if (queuedSubmissions.length === 0) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.postCreationQueueProcessingEnabled) {
        console.log("Post Creation: Post creation queue processing is disabled in control sub settings.");
        return;
    }

    const [firstSubmission] = queuedSubmissions;
    const submissionDetails = await context.redis.hGet(SUBMISSION_DETAILS, firstSubmission.member);
    if (!submissionDetails) {
        console.error(`Post Creation: No details found in redis for user ${firstSubmission.member}.`);
        await context.redis.zRem(SUBMISSION_QUEUE, [firstSubmission.member]);
        return;
    }

    const cooldownKey = "postCreationCooldown";
    if (await context.redis.exists(cooldownKey)) {
        console.log("Post Creation: Post creation is on cooldown. Skipping this run.");
        return;
    }

    await context.redis.set(cooldownKey, "", { expiration: addMinutes(new Date(), 3) });

    const txn = await context.redis.watch();
    await txn.multi();
    await txn.zRem(SUBMISSION_QUEUE, [firstSubmission.member]);
    await txn.hDel(SUBMISSION_DETAILS, [firstSubmission.member]);
    await txn.exec();

    await createNewSubmission(JSON.parse(submissionDetails) as AsyncSubmission, context);

    const remainingItemsInQueue = queuedSubmissions.length - 1;
    const firstItemNonUrgent = queuedSubmissions.find(item => item.score > subWeeks(new Date(), 1).getTime());

    if (remainingItemsInQueue > 0) {
        let message = `Post Creation: ${remainingItemsInQueue} ${pluralize("submission", remainingItemsInQueue)} still in the queue.`;
        if (firstItemNonUrgent) {
            message += ` Backlog: ${formatTimeSince(new Date(firstItemNonUrgent.score))}`;
        }
        console.log(message);
    }

    const alertKey = "postCreationQueueAlertSent";
    const maxQueueLengthKey = "postCreationQueueAlertMaxQueueLength";

    if (controlSubSettings.backlogWebhook) {
        if (remainingItemsInQueue > (controlSubSettings.postCreationQueueAlertLevel ?? 100) && !await context.redis.exists(alertKey)) {
            const messageId = await sendMessageToWebhook(controlSubSettings.backlogWebhook, `⚠️ Post creation queue is backlogged. There are currently ${remainingItemsInQueue} ${pluralize("submission", remainingItemsInQueue)} waiting to be processed.`);
            if (messageId) {
                await context.redis.set(alertKey, messageId);
                await context.redis.set(maxQueueLengthKey, remainingItemsInQueue.toString());
            }
        } else {
            const messageId = await context.redis.get(alertKey);
            const maxQueueLengthVal = await context.redis.get(maxQueueLengthKey);
            let maxQueueLength = maxQueueLengthVal ? parseInt(maxQueueLengthVal, 10) : 0;

            if (remainingItemsInQueue > 0 && messageId) {
                if (remainingItemsInQueue > maxQueueLength) {
                    maxQueueLength = remainingItemsInQueue;
                    await context.redis.set(maxQueueLengthKey, maxQueueLength.toString());
                }

                let message = `⚠️ Post creation queue is backlogged. As at <t:${Math.round(Date.now() / 1000)}:t> there ${pluralize("is", remainingItemsInQueue)} currently ${remainingItemsInQueue.toLocaleString()} ${pluralize("submission", remainingItemsInQueue)} waiting to be processed. (Max observed: ${maxQueueLength.toLocaleString()}).`;
                if (firstItemNonUrgent) {
                    message += `\n\nOldest non-urgent item: ${formatTimeSince(new Date(firstItemNonUrgent.score))} ago.`;
                }

                const immediateCount = queuedSubmissions.filter(item => item.score <= subWeeks(new Date(), 1).getTime()).length;
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
                await context.redis.del(alertKey, maxQueueLengthKey);
            }
        }
    }

    await context.redis.del(cooldownKey);
}
