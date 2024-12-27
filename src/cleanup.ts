import { TriggerContext } from "@devvit/public-api";
import { addDays, addHours, addMinutes, subMinutes } from "date-fns";
import { parseExpression } from "cron-parser";
import { ADHOC_CLEANUP_JOB, CLEANUP_JOB_CRON, CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants.js";
import { deleteUserStatus, getUserStatus, updateAggregate, UserStatus } from "./dataStore.js";
import { getUserOrUndefined } from "./utility.js";
import { removeRecordOfBan, removeWhitelistUnban } from "./handleClientSubredditWikiUpdate.js";

const CLEANUP_LOG_KEY = "CleanupLog";
const DAYS_BETWEEN_CHECKS = 28;

export async function setCleanupForUsers (usernames: string[], context: TriggerContext, controlSubOnly?: boolean, overrideDuration?: number) {
    if (controlSubOnly && context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    let cleanupTime: Date;
    if (overrideDuration) {
        cleanupTime = addHours(new Date(), overrideDuration);
    } else {
        cleanupTime = addDays(new Date(), DAYS_BETWEEN_CHECKS);
    }

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
        const pendingUsers: string[] = [];
        const otherUsers: string[] = [];
        for (const user of activeUsers) {
            const userStatus = await getUserStatus(user, context);
            if (userStatus?.userStatus === UserStatus.Pending) {
                pendingUsers.push(user);
            } else {
                otherUsers.push(user);
            }
        }

        // Users still in pending status should get checked more rapidly.
        if (pendingUsers.length > 0) {
            await setCleanupForUsers(pendingUsers, context, false, 1);
        }

        if (otherUsers.length > 0) {
            await setCleanupForUsers(otherUsers, context);
        }
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
            runAt: nextCleanupJobTime > new Date() ? nextCleanupJobTime : new Date(),
        });
    } else {
        console.log(`Cleanup: Next entry in cleanup log is after next scheduled run (${nextCleanupTime.toUTCString()}).`);
        console.log(`Cleanup: Next cleanup job: ${nextScheduledTime.toUTCString()}`);
    }
}

async function handleDeletedAccounts (usernames: string[], context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleDeletedAccountsControlSub(usernames, context);
    } else {
        await handleDeletedAccountsClientSub(usernames, context);
    }

    await context.redis.zRem(CLEANUP_LOG_KEY, usernames);
}

async function handleDeletedAccountsControlSub (usernames: string[], context: TriggerContext) {
    for (const username of usernames) {
        const status = await getUserStatus(username, context);
        if (!status) {
            console.log(`Cleanup: ${username} has no status to delete.`);
            continue;
        }

        let newStatus: UserStatus;
        switch (status.userStatus) {
            case UserStatus.Pending:
            case UserStatus.Retired:
            case UserStatus.Service:
                newStatus = UserStatus.Retired;
                break;
            default:
                newStatus = UserStatus.Purged;
                break;
        }

        if (status.userStatus !== newStatus) {
            await Promise.all([
                updateAggregate(status.userStatus, -1, context),
                updateAggregate(newStatus, 1, context),
            ]);
            console.log(`Aggregate for ${status.userStatus} decremented, ${newStatus} incremented for ${username}`);
        }

        try {
            const post = await context.reddit.getPostById(status.trackingPostId);
            await post.delete();

            console.log(`Cleanup: Post deleted for ${username}`);

            await context.redis.set(`ignoreflairchange:${post.id}`, "true", { expiration: addHours(new Date(), 1) });

            if (status.userStatus === newStatus) {
                continue;
            }

            await context.reddit.setPostFlair({
                postId: post.id,
                subredditName: CONTROL_SUBREDDIT,
                flairTemplateId: status.userStatus === UserStatus.Pending ? PostFlairTemplate.Retired : PostFlairTemplate.Purged,
            });
        } catch {
            console.log(`Unable to set flair for ${username} on post ${status.trackingPostId}`);
        }
    }

    await deleteUserStatus(usernames, context);
}

async function handleDeletedAccountsClientSub (usernames: string[], context: TriggerContext) {
    await removeRecordOfBan(usernames, context);
    await removeWhitelistUnban(usernames, context);
}
