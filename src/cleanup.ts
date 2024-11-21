import { TriggerContext, ZMember } from "@devvit/public-api";
import { addDays, addMinutes, subMinutes } from "date-fns";
import { parseExpression } from "cron-parser";
import { ADHOC_CLEANUP_JOB, CLEANUP_JOB_CRON, CONTROL_SUBREDDIT } from "./constants.js";
import { deleteUserStatus, getUserStatus, removeRecordOfBan, removeWhitelistUnban, updateAggregate, UserStatus } from "./dataStore.js";
import { getUserOrUndefined } from "./utility.js";

const CLEANUP_LOG_KEY = "CleanupLog";
const DAYS_BETWEEN_CHECKS = 28;

export async function setCleanupForUsers (usernames: string[], context: TriggerContext, controlSubOnly?: boolean, overrideDuration?: number) {
    if (controlSubOnly && context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const cleanupTime = addDays(new Date(), overrideDuration ?? DAYS_BETWEEN_CHECKS);
    await context.redis.zAdd(CLEANUP_LOG_KEY, ...usernames.map(username => ({ member: username, score: cleanupTime.getTime() })));
}

async function userActive (username: string, context: TriggerContext): Promise<boolean> {
    const user = await getUserOrUndefined(username, context);
    return user !== undefined;
}

interface UserActive {
    username: string;
    isActive: boolean;
}

export async function cleanupDeletedAccounts (_: unknown, context: TriggerContext) {
    const items = await context.redis.zRange(CLEANUP_LOG_KEY, 0, new Date().getTime(), { by: "score" });
    if (items.length === 0) {
        // No user accounts need to be checked.
        await scheduleAdhocCleanup(context);
        return;
    }

    // Check platform is up.
    await context.reddit.getAppUser();

    const itemsToCheck = 50;

    // Get the first N accounts that are due a check.
    const usersToCheck = items.slice(0, itemsToCheck).map(item => item.member);
    const userStatuses: UserActive[] = [];

    for (const username of usersToCheck) {
        const isActive = await userActive(username, context);
        userStatuses.push(({ username, isActive } as UserActive));
    }

    const activeUsers = userStatuses.filter(user => user.isActive).map(user => user.username);
    const deletedUsers = userStatuses.filter(user => !user.isActive).map(user => user.username);

    // For active users, set their next check date to be one day from now.
    if (activeUsers.length > 0) {
        await setCleanupForUsers(activeUsers, context);
        await context.redis.zAdd(CLEANUP_LOG_KEY, ...activeUsers.map(user => ({ member: user, score: addDays(new Date(), DAYS_BETWEEN_CHECKS).getTime() } as ZMember)));
    }

    // For deleted users, remove them from both the cleanup log and the points score.
    if (deletedUsers.length > 0) {
        await handleDeletedAccounts(deletedUsers, context);
    }

    console.log(`Cleanup: ${deletedUsers.length}/${userStatuses.length} deleted or suspended.`);

    if (items.length > itemsToCheck) {
        // In a backlog, so force another run.
        await context.scheduler.runJob({
            name: "cleanupDeletedAccounts",
            runAt: new Date(),
        });
    } else {
        await scheduleAdhocCleanup(context);
    }
}

export async function scheduleAdhocCleanup (context: TriggerContext) {
    const nextEntries = await context.redis.zRange(CLEANUP_LOG_KEY, 0, 0, { by: "rank" });

    if (nextEntries.length === 0) {
        return;
    }

    const nextCleanupTime = new Date(nextEntries[0].score);
    const nextCleanupJobTime = addMinutes(nextCleanupTime, 5);
    const nextScheduledTime = parseExpression(CLEANUP_JOB_CRON).next().toDate();

    if (nextCleanupJobTime < subMinutes(nextScheduledTime, 5)) {
        // It's worth running an ad-hoc job.
        console.log(`Cleanup: Next ad-hoc cleanup: ${nextCleanupJobTime.toUTCString()}`);
        await context.scheduler.runJob({
            name: ADHOC_CLEANUP_JOB,
            runAt: nextCleanupJobTime,
        });
    } else {
        console.log(`Cleanup: Next entry in cleanup log is after next scheduled run (${nextCleanupTime.toUTCString()}).`);
        console.log(`Cleanup: Next cleanup job: ${nextScheduledTime.toUTCString()}`);
    }
}

async function handleDeletedAccounts (usernames: string[], context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        for (const username of usernames) {
            const status = await getUserStatus(username, context);
            if (!status) {
                continue;
            }

            const newStatus = status.userStatus === UserStatus.Pending ? UserStatus.Retired : UserStatus.Purged;
            await updateAggregate(newStatus, 1, context);

            try {
                const post = await context.reddit.getPostById(status.trackingPostId);

                const newComment = await post.addComment({
                    text: "This post has been deleted, because the account it relates to is suspended, shadowbanned or deleted.",
                });

                await Promise.all([
                    newComment.distinguish(true),
                    post.delete(),
                ]);
            } catch {
                console.log(`Unable to set flair for ${username} on post ${status.trackingPostId}`);
            }
        }

        await deleteUserStatus(usernames, context);
    } else {
        await removeRecordOfBan(usernames, context);
        await removeWhitelistUnban(usernames, context);
    }

    await context.redis.zRem(CLEANUP_LOG_KEY, usernames);
}
