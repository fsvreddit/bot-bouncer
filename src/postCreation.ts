import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { getUserStatus, setUserStatus, UserDetails, UserStatus } from "./dataStore.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob, POST_CREATION_JOB_CRON, PostFlairTemplate } from "./constants.js";
import { UserExtended } from "./extendedDevvit.js";
import { addSeconds } from "date-fns";
import { CronExpressionParser } from "cron-parser";
import { getControlSubSettings } from "./settings.js";

// This is only exported for unit testing purposes.
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
    const currentStatus = await getUserStatus(submission.user.username, context);
    if (currentStatus) {
        console.error(`Post Creation: User ${submission.user.username} already has a status of ${currentStatus.userStatus}.`);
        return;
    }

    const newPost = await context.reddit.submitPost({
        subredditName: CONTROL_SUBREDDIT,
        title: `Overview for ${submission.user.username}`,
        url: `https://www.reddit.com/user/${submission.user.username}`,
        flairId: statusToFlair[submission.details.userStatus],
        nsfw: submission.user.nsfw,
    });

    submission.details.trackingPostId = newPost.id;

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
        const commentText = submission.callback.comment.replace("{{permalink}}", newPost.permalink);
        const newComment = await context.reddit.submitComment({
            id: submission.callback.postId,
            text: commentText,
        });
        await newComment.distinguish(true);
    }

    console.log(`Post Creation: Created new post for ${submission.user.username} with status ${submission.details.userStatus}.`);
}

export async function schedulePostCreation (context: TriggerContext, delay = 1) {
    await context.scheduler.runJob({
        name: ControlSubredditJob.AsyncPostCreationSchedule,
        runAt: addSeconds(new Date(), 1),
        data: { delay },
    });
}

export async function schedulePostCreationAsync (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const delay = event.data?.delay as number | undefined ?? 1;
    const queuedSubmissions = await context.redis.zRange(SUBMISSION_QUEUE, 0, 0);
    if (queuedSubmissions.length === 0) {
        console.log("Post Creation: No queued submissions to process.");
        return;
    }

    const currentJobs = await context.scheduler.listJobs();
    if (currentJobs.some(job => job.name === ControlSubredditJob.AsyncPostCreation as string && job.data?.mode === "async")) {
        return;
    }

    const nextScheduledSubmission = CronExpressionParser.parse(POST_CREATION_JOB_CRON).next().toDate();
    if (nextScheduledSubmission < addSeconds(new Date(), 30)) {
        console.log("Post Creation: Next scheduled submission is imminent. No need to schedule another job.");
        return;
    }

    console.log(`Post Creation: Scheduling post creation job with a delay of ${delay} seconds.`);

    await context.scheduler.runJob({
        name: ControlSubredditJob.AsyncPostCreation,
        data: { mode: "async" },
        runAt: addSeconds(new Date(), delay),
    });
}

export async function queuePostCreation (submission: AsyncSubmission, context: TriggerContext, schedule = false) {
    const currentStatus = await getUserStatus(submission.user.username, context);
    if (currentStatus) {
        console.error(`Post Creation: User ${submission.user.username} already has a status of ${currentStatus.userStatus}.`);
        return;
    }

    const alreadyInQueue = await context.redis.zScore(SUBMISSION_QUEUE, submission.user.username);
    if (alreadyInQueue) {
        console.error(`Post Creation: User ${submission.user.username} is already in the queue.`);
        return;
    }

    const score = submission.immediate ? 1 : new Date().getTime();

    await context.redis.hSetNX(SUBMISSION_DETAILS, submission.user.username, JSON.stringify(submission));
    await context.redis.zAdd(SUBMISSION_QUEUE, { member: submission.user.username, score });

    if (schedule) {
        await schedulePostCreation(context);
    }
}

export async function processQueuedSubmission (_: unknown, context: JobContext) {
    const queuedSubmissions = await context.redis.zRange(SUBMISSION_QUEUE, 0, 1);
    if (queuedSubmissions.length === 0) {
        console.log("Post Creation: No queued submissions to process.");
        return;
    }

    const [firstSubmission] = queuedSubmissions;
    const submissionDetails = await context.redis.hGet(SUBMISSION_DETAILS, firstSubmission.member);
    if (!submissionDetails) {
        console.error(`Post Creation: No details found in redis for user ${firstSubmission.member}.`);
        return;
    }

    await createNewSubmission(JSON.parse(submissionDetails) as AsyncSubmission, context);
    await context.redis.zRem(SUBMISSION_QUEUE, [firstSubmission.member]);
    await context.redis.hDel(SUBMISSION_DETAILS, [firstSubmission.member]);

    if (queuedSubmissions.length > 1) {
        console.log("Post Creation: There are more submissions in the queue, rescheduling the job.");
        // There are more submissions in the queue, so we need to reschedule the job.
        await schedulePostCreation(context, 20);
    }
}
