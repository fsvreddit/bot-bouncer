import { TriggerContext } from "@devvit/public-api";
import { addDays, addHours, addMinutes, subMinutes } from "date-fns";
import { parseExpression } from "cron-parser";
import { CLEANUP_JOB_CRON, CONTROL_SUBREDDIT, PostFlairTemplate, UniversalJob } from "./constants.js";
import { deleteUserStatus, getUserStatus, removeRecordOfSubmitterOrMod, updateAggregate, UserDetails, UserStatus } from "./dataStore.js";
import { getUserOrUndefined } from "./utility.js";
import { removeRecordOfBan, removeWhitelistUnban } from "./handleClientSubredditWikiUpdate.js";
import { getControlSubSettings } from "./settings.js";

const CLEANUP_LOG_KEY = "CleanupLog";
const SUB_OR_MOD_LOG_KEY = "SubOrModLog";
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

export async function setCleanupForSubmittersAndMods (usernames: string[], context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (usernames.length === 0) {
        return;
    }

    await context.redis.zAdd(SUB_OR_MOD_LOG_KEY, ...usernames.map(username => ({ member: username, score: new Date().getTime() })));
    await setCleanupForUsers(usernames, context, true);
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

    const itemsToCheck = 5;

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
        const purgedUsers: Record<string, UserDetails> = {};
        const otherUsers: string[] = [];
        for (const user of activeUsers) {
            const userStatus = await getUserStatus(user, context);
            if (userStatus?.userStatus === UserStatus.Pending) {
                pendingUsers.push(user);
            } else if (userStatus?.userStatus === UserStatus.Purged || userStatus?.userStatus === UserStatus.Retired) {
                purgedUsers[user] = userStatus;
            } else {
                otherUsers.push(user);
            }
        }

        // Users still in pending status should get checked more rapidly.
        if (pendingUsers.length > 0) {
            await setCleanupForUsers(pendingUsers, context, false, 1);
        }

        // Users who were formerly marked as "purged" or "retired" should be set back to "pending" or their last known status.
        for (const username of Object.keys(purgedUsers)) {
            if (context.subredditName === CONTROL_SUBREDDIT) {
                const currentStatus = await getUserStatus(username, context);
                let newTemplate = PostFlairTemplate.Pending;
                if (currentStatus?.lastStatus === UserStatus.Banned) {
                    newTemplate = PostFlairTemplate.Banned;
                } else if (currentStatus?.lastStatus === UserStatus.Organic) {
                    newTemplate = PostFlairTemplate.Organic;
                } else if (currentStatus?.lastStatus === UserStatus.Service) {
                    newTemplate = PostFlairTemplate.Service;
                }

                await context.reddit.setPostFlair({
                    postId: purgedUsers[username].trackingPostId,
                    subredditName: CONTROL_SUBREDDIT,
                    flairTemplateId: newTemplate,
                });

                const post = await context.reddit.getPostById(purgedUsers[username].trackingPostId);
                await context.reddit.report(post, { reason: `User has returned to pending status, formerly ${purgedUsers[username].userStatus}.` });
            }
            await setCleanupForUsers([username], context, true);
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
            name: UniversalJob.Cleanup,
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

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.cleanupDisabled) {
        console.log("Cleanup: Cleanup disabled in control subreddit settings.");
        return;
    }

    const nextCleanupTime = new Date(nextEntries[0].score);
    const nextCleanupJobTime = addMinutes(nextCleanupTime, 5);
    const nextScheduledTime = parseExpression(CLEANUP_JOB_CRON).next().toDate();

    if (nextCleanupJobTime < subMinutes(nextScheduledTime, 5)) {
        // It's worth running an ad-hoc job.
        console.log(`Cleanup: Next ad-hoc cleanup: ${nextCleanupJobTime.toUTCString()}`);

        const jobs = await context.scheduler.listJobs();
        const cleanupJobs = jobs.filter(job => job.name === UniversalJob.AdhocCleanup as string);
        if (cleanupJobs.length > 0) {
            await Promise.all(cleanupJobs.map(job => context.scheduler.cancelJob(job.id)));
        }

        await context.scheduler.runJob({
            name: UniversalJob.AdhocCleanup,
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
        const submitterOrModFlag = await context.redis.zScore(SUB_OR_MOD_LOG_KEY, username);

        if (!status && !submitterOrModFlag) {
            console.log(`Cleanup: ${username} has no status to delete.`);
            continue;
        }

        if (status) {
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
                console.log(`Cleanup: Aggregate for ${status.userStatus} decremented, ${newStatus} incremented for ${username}`);
            }

            try {
                const post = await context.reddit.getPostById(status.trackingPostId);
                await post.delete();

                const deletedPosts = await context.redis.incrBy("deletedPosts", 1);
                console.log(`Cleanup: Post deleted for ${username}. Now deleted ${deletedPosts} posts.`);
                if (status.userStatus === newStatus) {
                    continue;
                }

                await context.redis.set(`ignoreflairchange:${post.id}`, "true", { expiration: addHours(new Date(), 1) });

                await context.reddit.setPostFlair({
                    postId: post.id,
                    subredditName: CONTROL_SUBREDDIT,
                    flairTemplateId: status.userStatus === UserStatus.Pending ? PostFlairTemplate.Retired : PostFlairTemplate.Purged,
                });
            } catch {
                console.log(`Cleanup: Unable to set flair for ${username} on post ${status.trackingPostId}`);
            }
        }

        if (submitterOrModFlag) {
            await context.redis.zRem(SUB_OR_MOD_LOG_KEY, [username]);
            await removeRecordOfSubmitterOrMod(username, context);
        }
    }

    await deleteUserStatus(usernames, context);
}

async function handleDeletedAccountsClientSub (usernames: string[], context: TriggerContext) {
    await removeRecordOfBan(usernames, context);
    await removeWhitelistUnban(usernames, context);
    const keysToRemove = [...usernames.map(username => `removed:${username}`), ...usernames.map(username => `removedItems:${username}`)];
    await Promise.all(keysToRemove.map(key => context.redis.del(key)));
}
