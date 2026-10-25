import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { JsonValue } from "@devvit/web/shared";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { CONTROL_SUBREDDIT, evaluateUserAccount, getAccountInitialEvaluationResults, getFullDataStore, getUserStatus, PostFlairTemplate, setUserStatus, storeAccountInitialEvaluationResults, UserDetails } from "..";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addMinutes, addSeconds } from "date-fns";
import { getEvaluatorVariables } from "./evaluatorVariables";
import pluralize from "pluralize";
import { PendingUserReevaluationJobData } from "../../tasks";

const PENDING_USER_REEVALUATION_QUEUE_KEY = "pendingUserReevaluationQueue";

async function queuePendingUsers () {
    const pendingUsers = await getFullDataStore({
        statuses: [UserStatus.Pending],
    });

    const usernames = Object.keys(pendingUsers);
    if (usernames.length === 0) {
        return;
    }

    await redis.zAdd(PENDING_USER_REEVALUATION_QUEUE_KEY, ...usernames.map(username => ({ member: username, score: Date.now() })));
}

async function processPendingUser (username: string, evaluatorVariables: Record<string, JsonValue>) {
    const userStatus = await getUserStatus(username);
    if (userStatus?.userStatus !== UserStatus.Pending || userStatus.trackingPostId === "") {
        return;
    }

    const trackingPost = await reddit.getPostById(userStatus.trackingPostId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
    if (trackingPost.flair?.text && Object.values(UserStatus).includes(trackingPost.flair.text as UserStatus) && !await redis.exists(`postFlairUpdateLock~${username}`)) {
        const newUserStatus: UserDetails = {
            ...userStatus,
            operator: context.appSlug,
            lastUpdate: Date.now(),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            userStatus: trackingPost.flair.text as UserStatus,
        };
        await setUserStatus(username, newUserStatus);
        await trackingPost.approve();
    }

    const initialEvaluationResults = await getAccountInitialEvaluationResults(username);
    if (initialEvaluationResults.length > 0) {
        return;
    }

    const history = await reddit.getCommentsAndPostsByUser({
        username,
        limit: 100,
        sort: "new",
    }).all();

    const evaluationResults = await evaluateUserAccount({
        username,
        variables: evaluatorVariables,
        history,
    });

    if (evaluationResults.length === 0) {
        return;
    }

    if (!evaluationResults.some(result => result.canAutoBan && result.metThreshold)) {
        return;
    }

    await storeAccountInitialEvaluationResults(username, evaluationResults);
    console.log(`Pending User Reevaluation: User ${username} has been re-evaluated and flagged for banning.`);
    await reddit.setPostFlair({
        postId: userStatus.trackingPostId,
        flairTemplateId: PostFlairTemplate.Banned,
        subredditName: CONTROL_SUBREDDIT,
    });
}

export async function processPendingUserReevaluationQueue (event: TaskRequest<PendingUserReevaluationJobData>) {
    if (await hasEventBeenHandled(`job:${event.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Pending User Reevaluation: Job ${event.data.jobGuid} has already been handled. Skipping.`);
        return;
    }

    const runRecentlyKey = "pendingUserReevaluationRunRecently";

    if (event.data.firstRun) {
        if (await redis.exists(runRecentlyKey)) {
            console.log("Pending User Reevaluation: Job has run recently. Skipping.");
            return;
        }

        await queuePendingUsers();

        await scheduler.runJob<PendingUserReevaluationJobData>({
            name: "pendingUserReevaluation",
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
            runAt: new Date(),
        });

        return;
    }

    await redis.set(runRecentlyKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const runLimit = addSeconds(new Date(), 15);

    const pendingUsers = await redis.zRange(PENDING_USER_REEVALUATION_QUEUE_KEY, 0, -1).then(entries => entries.map(entry => entry.member));
    if (pendingUsers.length === 0) {
        console.log("Pending User Reevaluation: No pending users to process.");
        return;
    }

    console.log(`Pending User Reevaluation: Processing ${pendingUsers.length} pending ${pluralize("user", pendingUsers.length)}.`);

    const evaluatorVariables = await getEvaluatorVariables();

    let processed = 0;
    while (pendingUsers.length > 0 && new Date() < runLimit) {
        const username = pendingUsers.shift();
        if (!username) {
            break;
        }

        await redis.zRem(PENDING_USER_REEVALUATION_QUEUE_KEY, [username]);
        await processPendingUser(username, evaluatorVariables);
        processed++;
    }

    if (pendingUsers.length > 0) {
        console.log(`Pending User Reevaluation: Processed ${processed} pending ${pluralize("user", processed)}. ${pendingUsers.length} remaining.`);
        await scheduler.runJob<PendingUserReevaluationJobData>({
            name: "pendingUserReevaluation",
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        console.log(`Pending User Reevaluation: All remaining ${processed} pending ${pluralize("user", processed)} processed.`);
        await redis.del(runRecentlyKey);
    }
}
