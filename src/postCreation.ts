import { JobContext, TriggerContext } from "@devvit/public-api";
import { getUserStatus, setUserStatus, storeInitialAccountProperties, UserDetails, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob, PostFlairTemplate } from "./constants.js";
import { UserExtended } from "./extendedDevvit.js";
import { addHours, addSeconds } from "date-fns";
import { getControlSubSettings } from "./settings.js";
import pluralize from "pluralize";
import { processFeedbackQueue, queueSendFeedback } from "./submissionFeedback.js";

export const statusToFlair: Record<UserStatus, PostFlairTemplate> = {
    [UserStatus.Pending]: PostFlairTemplate.Pending,
    [UserStatus.Banned]: PostFlairTemplate.Banned,
    [UserStatus.Service]: PostFlairTemplate.Service,
    [UserStatus.Organic]: PostFlairTemplate.Organic,
    [UserStatus.Purged]: PostFlairTemplate.Purged,
    [UserStatus.Retired]: PostFlairTemplate.Retired,
    [UserStatus.Declined]: PostFlairTemplate.Declined,
    [UserStatus.Inactive]: PostFlairTemplate.Inactive,
};

const SUBMISSION_QUEUE = "submissionQueue";
const SUBMISSION_DETAILS = "submissionDetails";

export interface AsyncSubmission {
    user: UserExtended;
    details: UserDetails;
    commentToAdd?: string;
    removeComment?: boolean;
    callback?: {
        postId: string;
        comment: string;
    };
    immediate: boolean;
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

    if (submission.details.submitter === "bot-sleuth-bot") {
        const userHistory = await context.reddit.getCommentsAndPostsByUser({
            username: submission.user.username,
            sort: "new",
            limit: 100,
        }).all();

        if (userHistory.length === 0) {
            console.log(`Post Creation: bot-sleuth-bot submission for ${submission.user.username} is curating history, skipping post creation.`);
            return;
        }
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

    if (submission.details.userStatus === UserStatus.Pending) {
        const controlSubSettings = await getControlSubSettings(context);
        if (!controlSubSettings.evaluationDisabled) {
            await context.scheduler.runJob({
                name: ControlSubredditJob.EvaluateUser,
                runAt: addSeconds(new Date(), 5),
                data: {
                    username: submission.user.username,
                    postId: newPost.id,
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
        }
    }

    await storeInitialAccountProperties(submission.user.username, context);

    if (submission.details.userStatus !== UserStatus.Pending) {
        await queueSendFeedback(submission.user.username, context);
    }

    if (submission.details.userStatus === UserStatus.Banned) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.DefinedHandlesPostStore,
            runAt: addSeconds(new Date(), 1),
            data: { username: submission.user.username },
        });
    }

    console.log(`Post Creation: Created new post for ${submission.user.username} with status ${submission.details.userStatus}.`);
}

export async function queuePostCreation (submission: AsyncSubmission, context: TriggerContext) {
    const currentStatus = await getUserStatus(submission.user.username, context);
    if (currentStatus) {
        console.log(`Post Creation: User ${submission.user.username} already has a status of ${currentStatus.userStatus}.`);
        return;
    }

    const score = submission.immediate ? new Date().getTime() / 1000 : new Date().getTime();

    const txn = await context.redis.watch();
    await txn.multi();

    try {
        const alreadyInQueue = await context.redis.zScore(SUBMISSION_QUEUE, submission.user.username);
        if (alreadyInQueue) {
            console.log(`Post Creation: User ${submission.user.username} is already in the queue.`);
            await txn.discard();
            return;
        }

        await txn.hSet(SUBMISSION_DETAILS, { [submission.user.username]: JSON.stringify(submission) });
        await txn.zAdd(SUBMISSION_QUEUE, { member: submission.user.username, score });
        await txn.exec();
    } catch (error) {
        console.error(`Post Creation: Error queueing post for user ${submission.user.username}.`, error);
        await txn.discard();
    }
}

export async function processQueuedSubmission (_: unknown, context: JobContext) {
    const queuedSubmissions = await context.redis.zRange(SUBMISSION_QUEUE, 0, -1);
    if (queuedSubmissions.length === 0) {
        // No submissions to process, so process feedback queue instead.
        await processFeedbackQueue(context);
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

    const txn = await context.redis.watch();
    await txn.multi();
    await txn.zRem(SUBMISSION_QUEUE, [firstSubmission.member]);
    await txn.hDel(SUBMISSION_DETAILS, [firstSubmission.member]);
    await txn.exec();

    await createNewSubmission(JSON.parse(submissionDetails) as AsyncSubmission, context);

    if (queuedSubmissions.length > 1) {
        console.log(`Post Creation: ${queuedSubmissions.length - 1} ${pluralize("submission", queuedSubmissions.length - 1)} still in the queue.`);
    }
}
