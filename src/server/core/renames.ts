import { context, reddit, redis, scheduler, User } from "@devvit/web/server";
import { T2 } from "@devvit/web/shared";
import { AsyncSubmission, CLEANUP_LOG_KEY, CONTROL_SUBREDDIT, ControlSubredditJob, getAccountInitialEvaluationResults, getUserStatus, handleDeletedAccountControlSub, queuePostCreation, storeAccountInitialEvaluationResults, UserDetails } from ".";
import { getUserExtendedFromUser, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { ProcessRenameQueueJobData } from "../tasks";
import { addMinutes, addSeconds } from "date-fns";

const RENAME_QUEUE_KEY = "RenameQueue";

function getT2KeyForUser (username: string): string {
    return `usernameToT2:${username}`;
}

function getUsernameKeyForT2 (t2ID: T2): string {
    return `t2ToUsername:${t2ID}`;
}

export async function storeRenameRecords (username: string, t2ID: T2) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("storeRenameRecords can only be called from the control subreddit.");
    }

    const existingValueForT2 = await redis.global.get(getUsernameKeyForT2(t2ID));
    if (existingValueForT2) {
        await redis.global.del(getT2KeyForUser(existingValueForT2));
    }

    await redis.global.mSet({
        [getT2KeyForUser(username)]: t2ID,
        [getUsernameKeyForT2(t2ID)]: username,
    });
}

export async function isUserPotentiallyRenamed (username: string, t2ID: T2): Promise<boolean> {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("isUserPotentiallyRenamed can only be called from the client subreddit.");
    }

    const storedUsername = await redis.global.get(getUsernameKeyForT2(t2ID));
    return storedUsername !== undefined && storedUsername !== username;
}

export async function queueRenamedUser (t2ID: T2) {
    await redis.global.zAdd(RENAME_QUEUE_KEY, { member: t2ID, score: new Date().getTime() });
    console.log(`Renames: Queued rename for user with T2 ID ${t2ID}.`);
}

async function renameUser (t2ID: T2): Promise<void> {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("renameUser can only be called from the control subreddit.");
    }

    let user: User | undefined;
    try {
        user = await reddit.getUserById(t2ID);
        if (!user) {
            return;
        }
    } catch (error) {
        throw new Error(`Failed to fetch user by ID ${t2ID}: ${error}`, { cause: error });
    }

    const username = user.username;

    const records = await redis.global.mGet([
        getT2KeyForUser(username),
        getUsernameKeyForT2(t2ID),
    ]);

    const storedT2Id = records[0] ?? undefined as T2 | undefined;
    const storedUsername = records[1] ?? undefined as string | undefined;

    if (!storedUsername || (storedT2Id === t2ID && storedUsername === username)) {
        // No rename has occurred.
        return;
    }

    const existingUserDetails = await getUserStatus(storedUsername);
    if (!existingUserDetails) {
        return;
    }

    const newUserDetails: UserDetails = {
        ...existingUserDetails,
        trackingPostId: "",
    };

    const promises: Promise<unknown>[] = [
        redis.global.del(getT2KeyForUser(storedUsername), getUsernameKeyForT2(t2ID)),
    ];

    const initialAccountEvaluationResults = await getAccountInitialEvaluationResults(storedUsername);
    if (initialAccountEvaluationResults.length > 0) {
        promises.push(storeAccountInitialEvaluationResults(username, initialAccountEvaluationResults));
    }

    const newSubmission: AsyncSubmission = {
        user: getUserExtendedFromUser(user),
        details: newUserDetails,
        immediate: true,
        submitter: existingUserDetails.submitter ?? context.appSlug,
        commentToAdd: `User has been renamed from u/${storedUsername} to u/${username}.`,
        removeComment: true,
        evaluatorsChecked: true,
    };

    promises.push(queuePostCreation([newSubmission]));
    promises.push(reddit.addModNote({
        subreddit: CONTROL_SUBREDDIT,
        note: `User has been renamed from u/${storedUsername} to u/${username}.`,
        user: username,
    }));

    promises.push(handleDeletedAccountControlSub(storedUsername, existingUserDetails));
    promises.push(redis.zRem(CLEANUP_LOG_KEY, [storedUsername]));

    const results = await Promise.allSettled(promises);

    if (results.some(result => result.status === "rejected")) {
        console.error(`Renames: Some promises failed for rename from ${storedUsername} to ${username}.`);
    } else {
        console.log(`Renames: ➡️ Rename from ${storedUsername} to ${username} completed successfully.`);
    }
}

export async function deleteRenameRecords (username: string) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("deleteRenameRecords can only be called from the control subreddit.");
    }

    const storedT2Id = await redis.global.get(getT2KeyForUser(username));
    const keysToDelete = [getT2KeyForUser(username)];
    if (storedT2Id) {
        keysToDelete.push(getUsernameKeyForT2(storedT2Id as T2));
    }
    await redis.global.del(...keysToDelete);
}

export async function queueRenameUserJob () {
    const queuedEntries = await redis.global.zCard(RENAME_QUEUE_KEY);
    if (queuedEntries === 0) {
        return;
    }

    await scheduler.runJob<ProcessRenameQueueJobData>({
        name: ControlSubredditJob.ProcessRenameQueue,
        runAt: new Date(),
        data: {
            jobGuid: crypto.randomUUID(),
        },
    });
}

export async function processRenameQueue (data: ProcessRenameQueueJobData) {
    if (await hasEventBeenHandled(`job:${data.jobGuid}`, { expiration: addMinutes(new Date(), 1) })) {
        return;
    }

    const runLimit = addSeconds(new Date(), 15);

    const queue = await redis.global.zRange(RENAME_QUEUE_KEY, 0, -1).then(queue => queue.map(item => item.member as T2));

    while (queue.length > 0 && new Date() < runLimit) {
        const entry = queue.shift();
        if (!entry) {
            break;
        }

        await renameUser(entry);

        await redis.global.zRem(RENAME_QUEUE_KEY, [entry]);
    }

    if (queue.length > 0) {
        await scheduler.runJob<ProcessRenameQueueJobData>({
            name: ControlSubredditJob.ProcessRenameQueue,
            runAt: new Date(),
            data: {
                jobGuid: crypto.randomUUID(),
            },
        });
    }
}
