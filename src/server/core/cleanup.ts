import { Comment, context, Post, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { getUserExtended, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addMinutes, addSeconds, addWeeks, subDays, subMinutes, subSeconds } from "date-fns";
import { CONTROL_SUBREDDIT, PostFlairTemplate } from "./constants";
import { getControlSubSettings } from "./controlSubSettings";
import { deleteUserStatus, getUserStatus, removeRecordOfSubmitterOrMod, setUserStatusAndFlair, updateAggregate, writeUserStatus } from "./dataStore";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { UserFlag } from "./types";
import { formatTimeSince } from "./utility";
import { UniversalJob } from "./schedulerJobs";
import { CleanupJobData } from "../tasks";
import { addUserToRecoveredRechecksQueue } from "./controlSubCore";
import { submitAccountForReview } from "./controlSubCore/modmail";
import { removeRecordOfBan, removeWhitelistUnban } from "./clientSubCore";
import { max } from "lodash-es";

export const CLEANUP_LOG_KEY = "CleanupLog";
const SUB_OR_MOD_LOG_KEY = "SubOrModLog";
const DAYS_BETWEEN_CHECKS = 28;

export async function userHasCleanupEntry (username: string): Promise<boolean> {
    return await redis.zScore(CLEANUP_LOG_KEY, username).then(score => score !== undefined);
}

export async function setCleanupForUser (username: string, overrideDate?: Date) {
    let cleanupTime = overrideDate ?? addDays(new Date(), DAYS_BETWEEN_CHECKS);

    // Fuzz cleanup time in case a big batch happened at the same time.
    if (!overrideDate) {
        const secondsInOneDay = 24 * 60 * 60;
        const fuzzFactor = Math.floor(Math.random() * secondsInOneDay);
        cleanupTime = subSeconds(cleanupTime, fuzzFactor);
    }

    await redis.zAdd(CLEANUP_LOG_KEY, ({ member: username, score: cleanupTime.getTime() }));
}

export async function setCleanupForSubmittersAndMods (usernames: string[]) {
    if (usernames.length === 0) {
        return;
    }

    await redis.zAdd(SUB_OR_MOD_LOG_KEY, ...usernames.map(username => ({ member: username, score: new Date().getTime() })));
    await Promise.all(usernames.map(username => setCleanupForUser(username)));
}

export async function isUserSubmitterOrMod (username: string): Promise<boolean> {
    const score = await redis.zScore(SUB_OR_MOD_LOG_KEY, username);
    return score !== undefined;
}

enum UserActiveStatus {
    Active = "active",
    Deleted = "deleted",
    Suspended = "suspended",
    Shadowbanned = "shadowbanned",
}

async function userActive (username: string): Promise<UserActiveStatus> {
    const user = await getUserExtended(username);
    if (user?.isSuspended) {
        return UserActiveStatus.Suspended;
    }

    if (user) {
        return UserActiveStatus.Active;
    }

    /* If the user could not be retrieved, they may be suspended, shadowbanned or deleted.
     *
     * This can be tested by attempting to retrieve mod notes. Mod notes for shadowbanned or suspended
     * users can be retrieved, but deleted users will return an error. We only need to do this on the
     * control subreddit, because the client subreddit's cleanup requirements are different.
     * */
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return UserActiveStatus.Deleted;
    }

    try {
        await reddit.getModNotes({
            subreddit: CONTROL_SUBREDDIT,
            user: username,
        }).all();
        // User is either suspended or shadowbanned.
        return UserActiveStatus.Shadowbanned;
    } catch {
        // User is deleted.
        return UserActiveStatus.Deleted;
    }
}

export async function cleanupDeletedAccounts (event: TaskRequest<CleanupJobData>) {
    const controlSubSettings = await getControlSubSettings();
    if (controlSubSettings.cleanupDisabled && context.subredditName === CONTROL_SUBREDDIT) {
        console.log("Cleanup: Cleanup is disabled, skipping.");
        return;
    }

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Cleanup: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const items = await redis.zRange(CLEANUP_LOG_KEY, 0, new Date().getTime(), { by: "score" });
    if (items.length === 0) {
        return;
    }

    const runLimit = addSeconds(new Date(), 20);

    const recentlyRunKey = "CleanupRecentlyRun";

    if (event.data.firstRun && await redis.exists(recentlyRunKey)) {
        return;
    }

    if (event.data.firstRun) {
        console.log(`Cleanup: First run, processing ${items.length} users.`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstCleanupDate = new Date(items[0]!.score);

    await redis.set(recentlyRunKey, "true", { expiration: addMinutes(new Date(), 1) });

    // Check platform is up.
    await reddit.getAppUser();

    let deletedCount = 0;
    let activeCount = 0;
    let suspendedCount = 0;

    // Get the first N accounts that are due a check.
    const usersToCheck = items.map(item => item.member);
    while (usersToCheck.length > 0 && new Date() < runLimit) {
        const username = usersToCheck.shift();
        if (!username) {
            break;
        }

        // Push forward cleanup by one day in case retrieving user fails catastrophically.
        await setCleanupForUser(username, addDays(new Date(), 1));

        const currentUserStatus = await userActive(username);

        if (currentUserStatus === UserActiveStatus.Deleted) {
            await handleDeletedAccount(username);
            deletedCount++;
            continue;
        }

        // If we're on a client subreddit, no need to do further checks.
        if (context.subredditName !== CONTROL_SUBREDDIT) {
            await setCleanupForUser(username);
            continue;
        }

        let overrideCleanupDate: Date | undefined;
        const currentStatus = await getUserStatus(username);

        // If no current status is defined, then this entry should not have been reached.
        if (!currentStatus) {
            if (await isUserSubmitterOrMod(username)) {
                console.log(`Cleanup: ${username} has no status, but was in submitter or mod log.`);
                await setCleanupForUser(username);
                continue;
            }
            console.log(`Cleanup: No status for ${username}, but was in cleanup queue.`);
            await redis.zRem(CLEANUP_LOG_KEY, [username]);
            continue;
        }

        let newStatus: UserStatus | UserFlag | undefined;

        if (currentUserStatus === UserActiveStatus.Active) {
            activeCount++;
            if (currentStatus.userStatus === UserStatus.Pending) {
                // User is still pending, so set the next check date to be very soon to allow for pending->retired transitions.
                overrideCleanupDate = addMinutes(new Date(), 15);
            } else if (currentStatus.userStatus === UserStatus.Banned && new Date(currentStatus.lastUpdate) > subDays(new Date(), 8)) {
                // Recheck banned but active users every day for the first week.
                overrideCleanupDate = addDays(new Date(), 1);
            } else if (currentStatus.userStatus === UserStatus.Banned) {
                // User is banned, but has been active for more than a week. Check every week.
                overrideCleanupDate = addWeeks(new Date(), 1);
            } else if (currentStatus.userStatus === UserStatus.Purged || currentStatus.userStatus === UserStatus.Retired) {
                // User's last status was purged or retired, but user is now active again. Restore last status or Pending.
                switch (currentStatus.lastStatus) {
                    case UserStatus.Banned:
                        newStatus = UserStatus.Banned;
                        break;
                    case UserStatus.Organic:
                        newStatus = UserStatus.Organic;
                        break;
                    case UserStatus.Service:
                        newStatus = UserStatus.Service;
                        break;
                    default:
                        newStatus = UserStatus.Pending;
                        break;
                }
            }

            if (currentStatus.userStatus === UserStatus.Inactive) {
                // Check for recent activity to potentially change status from Inactive to Pending.
                const latestContent = await getLatestContentDate(username);
                if (latestContent && new Date(latestContent) > subDays(new Date(), 14) && new Date(latestContent) > new Date(currentStatus.lastUpdate)) {
                    newStatus = UserStatus.Pending;
                }
                overrideCleanupDate = addWeeks(new Date(), 1);
            }

            if (!newStatus && controlSubSettings.autoAccountRecoveryEnabled) {
                await addUserToRecoveredRechecksQueue(username, currentStatus);
            }

            if (currentStatus.flags?.includes(UserFlag.FutureNSFW)) {
                // Check to see if the user has any new NSFW content. If they do, set a reminder for the user.
                const posts = await reddit.getPostsByUser({
                    username,
                    limit: 100,
                    sort: "new",
                }).all();

                const hasNewNSFWContent = posts.some(post => post.nsfw && post.createdAt.getTime() > currentStatus.lastUpdate);
                if (hasNewNSFWContent) {
                    // Clear the flag.
                    const newFlags = currentStatus.flags.filter(flag => flag !== UserFlag.FutureNSFW);
                    const newStatus = {
                        ...currentStatus,
                        flags: newFlags.length > 0 ? newFlags : undefined,
                    };
                    await writeUserStatus(username, newStatus);
                    await submitAccountForReview({
                        duration: 0,
                        postId: currentStatus.trackingPostId as T3,
                        reviewReason: "User was flagged as a potential future adult content creator and now has NSFW content",
                        reviewRequestedBy: context.appSlug,
                    });
                } else {
                    overrideCleanupDate = addDays(new Date(), 3);
                }
            }

            if (controlSubSettings.allowRechecks && currentStatus.flags?.some(flag => [UserFlag.HackedAndRecovered, UserFlag.Scammed, UserFlag.FutureNSFW].includes(flag))) {
                await redis.zAdd("flaggedRechecksQueue", { member: username, score: new Date().getTime() });
            }
        } else {
            suspendedCount++;
            // User's current status is Suspended or Shadowbanned.
            if (currentStatus.userStatus === UserStatus.Pending) {
                // Users who are currently pending but where the user is suspended or shadowbanned should be set to Retired.
                newStatus = UserStatus.Retired;
            } else if (currentStatus.userStatus !== UserStatus.Purged && currentStatus.userStatus !== UserStatus.Retired) {
                // User is active in the DB, but currently suspended or shadowbanned.
                // Change the post flair to Purged.
                newStatus = UserStatus.Purged;
            }

            // Recheck suspended users every day for the first week
            if (new Date(currentStatus.lastUpdate) > subDays(new Date(), 8)) {
                overrideCleanupDate = addDays(new Date(), 1);
            }
        }

        await setCleanupForUser(username, overrideCleanupDate);

        if (newStatus && currentStatus.trackingPostId !== "") {
            await setUserStatusAndFlair({
                username,
                operator: context.appSlug,
                newStatusOrFlag: newStatus,
                currentDetails: currentStatus,
            });
        }
    }

    let message = `Cleanup: Active ${activeCount}, Deleted ${deletedCount}, Suspended ${suspendedCount}.`;
    if (firstCleanupDate < subMinutes(new Date(), 2)) {
        message += ` Backlogged: ${formatTimeSince(firstCleanupDate)}.`;
    }

    console.log(message);

    if (usersToCheck.length > 0) {
        await scheduler.runJob({
            name: UniversalJob.Cleanup,
            runAt: addSeconds(new Date(), 2),
            data: { jobGuid: crypto.randomUUID() },
        });
    } else {
        await redis.del(recentlyRunKey);
    }
}

async function handleDeletedAccount (username: string) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleDeletedAccountControlSub(username);
    } else {
        await handleDeletedAccountClientSub(username);
    }

    await redis.zRem(CLEANUP_LOG_KEY, [username]);
}

async function handleDeletedAccountControlSub (username: string) {
    const status = await getUserStatus(username);
    const submitterOrModFlag = await isUserSubmitterOrMod(username);

    if (!status && !submitterOrModFlag) {
        console.log(`Cleanup: ${username} has no status to delete.`);
        return;
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
            await updateAggregate(status.userStatus, -1);
            await updateAggregate(newStatus, 1);
            console.log(`Cleanup: Aggregate for ${status.userStatus} decremented, ${newStatus} incremented for ${username}`);
        }

        try {
            const post = await reddit.getPostById(status.trackingPostId as T3);
            if (post.authorName === context.appSlug) {
                await post.delete();
                const deletedPosts = await redis.incrBy("deletedPosts", 1);
                console.log(`Cleanup: Post deleted for ${username}. Now deleted ${deletedPosts} posts.`);

                if (status.userStatus !== newStatus) {
                    await reddit.setPostFlair({
                        postId: post.id,
                        subredditName: CONTROL_SUBREDDIT,
                        flairTemplateId: status.userStatus === UserStatus.Pending ? PostFlairTemplate.Retired : PostFlairTemplate.Purged,
                    });
                }
            }
        } catch (error) {
            console.log(`Cleanup: Unable to set flair for ${username} on post ${status.trackingPostId}`);
            console.error(error);
        }
    }

    if (submitterOrModFlag) {
        await removeRecordOfSubmitterOrMod(username);
        await redis.zRem(SUB_OR_MOD_LOG_KEY, [username]);
    }

    await deleteUserStatus(username);
}

async function handleDeletedAccountClientSub (username: string) {
    await removeRecordOfBan(username);
    await removeWhitelistUnban(username);
    await redis.del(`removed:${username}`, `removedItems:${username}`, `lockedItems:${username}`);
}

async function getLatestContentDate (username: string): Promise<number | undefined> {
    let content: (Post | Comment)[];
    try {
        content = await reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
        }).all();
    } catch {
        return;
    }

    return max(content.map(content => content.createdAt.getTime()));
}
