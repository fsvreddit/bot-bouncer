import { JobContext, JSONValue, ScheduledJobEvent } from "@devvit/public-api";
import { getFullDataStore, getUserStatus } from "../dataStore.js";
import { UserStatus } from "../types.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";
import { addMinutes, addSeconds } from "date-fns";
import { evaluateUserAccount, getAccountInitialEvaluationResults, storeAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { getEvaluatorVariables } from "./evaluatorVariables.js";
import pluralize from "pluralize";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "../constants.js";

export type PendingUserReevaluationJobData = {
    firstRun: boolean;
    jobGuid: string;
};

const PENDING_USER_REEVALUATION_QUEUE_KEY = "pendingUserReevaluationQueue";

async function queuePendingUsers (context: JobContext) {
    const pendingUsers = await getFullDataStore(context, {
        statuses: [UserStatus.Pending],
    });

    const usernames = Object.keys(pendingUsers);
    if (usernames.length === 0) {
        return;
    }

    await context.redis.zAdd(PENDING_USER_REEVALUATION_QUEUE_KEY, ...usernames.map(username => ({ member: username, score: Date.now() })));
}

async function processPendingUser (username: string, evaluatorVariables: Record<string, JSONValue>, context: JobContext) {
    const userStatus = await getUserStatus(username, context);
    if (userStatus?.userStatus !== UserStatus.Pending || userStatus.trackingPostId === "") {
        return;
    }

    const initialEvaluationResults = await getAccountInitialEvaluationResults(username, context);
    if (initialEvaluationResults.length > 0) {
        return;
    }

    const history = await context.reddit.getCommentsAndPostsByUser({
        username,
        limit: 100,
        sort: "new",
    }).all();

    const evaluationResults = await evaluateUserAccount({
        username,
        variables: evaluatorVariables,
        history,
    }, context);

    if (evaluationResults.length === 0) {
        return;
    }

    if (!evaluationResults.some(result => result.canAutoBan && result.metThreshold)) {
        return;
    }

    await storeAccountInitialEvaluationResults(username, evaluationResults, context);
    console.log(`Pending User Reevaluation: User ${username} has been re-evaluated and flagged for banning.`);
    await context.reddit.setPostFlair({
        postId: userStatus.trackingPostId,
        flairTemplateId: PostFlairTemplate.Banned,
        subredditName: CONTROL_SUBREDDIT,
    });
}

export async function processPendingUserReevaluationQueue (event: ScheduledJobEvent<PendingUserReevaluationJobData>, context: JobContext) {
    if (await hasTriggerBeenHandled(context.redis, `job:${event.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Pending User Reevaluation: Job ${event.data.jobGuid} has already been handled. Skipping.`);
        return;
    }

    const runRecentlyKey = "pendingUserReevaluationRunRecently";

    if (event.data.firstRun) {
        if (await context.redis.exists(runRecentlyKey)) {
            console.log("Pending User Reevaluation: Job has run recently. Skipping.");
            return;
        }

        await queuePendingUsers(context);

        await context.scheduler.runJob<PendingUserReevaluationJobData>({
            name: "pendingUserReevaluation",
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
            runAt: new Date(),
        });

        return;
    }

    await context.redis.set(runRecentlyKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const runLimit = addSeconds(new Date(), 15);

    const pendingUsers = await context.redis.zRange(PENDING_USER_REEVALUATION_QUEUE_KEY, 0, -1).then(entries => entries.map(entry => entry.member));
    if (pendingUsers.length === 0) {
        console.log("Pending User Reevaluation: No pending users to process.");
        return;
    }

    console.log(`Pending User Reevaluation: Processing ${pendingUsers.length} pending ${pluralize("user", pendingUsers.length)}.`);

    const evaluatorVariables = await getEvaluatorVariables(context);

    let processed = 0;
    while (pendingUsers.length > 0 && new Date() < runLimit) {
        const username = pendingUsers.shift();
        if (!username) {
            break;
        }

        await context.redis.zRem(PENDING_USER_REEVALUATION_QUEUE_KEY, [username]);
        await processPendingUser(username, evaluatorVariables, context);
        processed++;
    }

    if (pendingUsers.length > 0) {
        console.log(`Pending User Reevaluation: Processed ${processed} pending ${pluralize("user", processed)}. ${pendingUsers.length} remaining.`);
        await context.scheduler.runJob<PendingUserReevaluationJobData>({
            name: "pendingUserReevaluation",
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        console.log(`Pending User Reevaluation: All remaining ${processed} pending ${pluralize("user", processed)} processed.`);
        await context.redis.del(runRecentlyKey);
    }
}
