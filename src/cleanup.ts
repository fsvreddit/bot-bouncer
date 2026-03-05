import { Comment, JobContext, JSONObject, Post, RedisClient, ScheduledJobEvent, TriggerContext, TxClientLike } from "@devvit/public-api";
import { addDays, addHours, addSeconds, subDays, subMinutes, subSeconds } from "date-fns";
import { CONTROL_SUBREDDIT, PostFlairTemplate, UniversalJob } from "./constants.js";
import { deleteUserStatus, getUserStatus, removeRecordOfSubmitterOrMod, updateAggregate, UserStatus, writeUserStatus } from "./dataStore.js";
import { getUserExtended } from "./extendedDevvit.js";
import { removeRecordOfBan, removeWhitelistUnban } from "./handleClientSubredditClassificationChanges.js";
import _ from "lodash";
import { getControlSubSettings } from "./settings.js";
import { formatTimeSince } from "./utility.js";

export const CLEANUP_LOG_KEY = "CleanupLog";
const SUB_OR_MOD_LOG_KEY = "SubOrModLog";
const DAYS_BETWEEN_CHECKS = 28;

export async function userHasCleanupEntry (username: string, context: JobContext | TriggerContext): Promise<boolean> {
    return await context.redis.zScore(CLEANUP_LOG_KEY, username).then(score => score !== undefined);
}

export async function setCleanupForUser (username: string, redis: RedisClient | TxClientLike, overrideDate?: Date) {
    let cleanupTime = overrideDate ?? addDays(new Date(), DAYS_BETWEEN_CHECKS);

    // Fuzz cleanup time in case a big batch happened at the same time.
    if (!overrideDate) {
        const secondsInOneDay = 24 * 60 * 60;
        const fuzzFactor = Math.floor(Math.random() * secondsInOneDay);
        cleanupTime = subSeconds(cleanupTime, fuzzFactor);
    }

    await redis.zAdd(CLEANUP_LOG_KEY, ({ member: username, score: cleanupTime.getTime() }));
}

export async function setCleanupForSubmittersAndMods (usernames: string[], context: JobContext | TriggerContext) {
    if (usernames.length === 0) {
        return;
    }

    await context.redis.zAdd(SUB_OR_MOD_LOG_KEY, ...usernames.map(username => ({ member: username, score: new Date().getTime() })));
    await Promise.all(usernames.map(username => setCleanupForUser(username, context.redis)));
}

enum UserActiveStatus {
    Active = "active",
    Deleted = "deleted",
    Suspended = "suspended",
}

async function userActive (username: string, context: TriggerContext): Promise<UserActiveStatus> {
    const user = await getUserExtended(username, context);
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
        await context.reddit.getModNotes({
            subreddit: CONTROL_SUBREDDIT,
            user: username,
        }).all();
        // User is either suspended or shadowbanned.
        return UserActiveStatus.Suspended;
    } catch {
        // User is deleted.
        return UserActiveStatus.Deleted;
    }
}

export async function cleanupDeletedAccounts (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.cleanupDisabled && context.subredditName === CONTROL_SUBREDDIT) {
        console.log("Cleanup: Cleanup is disabled, skipping.");
        return;
    }

    const items = await context.redis.zRange(CLEANUP_LOG_KEY, 0, new Date().getTime(), { by: "score" });
    if (items.length === 0) {
        return;
    }

    const runLimit = addSeconds(new Date(), 10);

    const recentlyRunKey = "CleanupRecentlyRun";

    if (event.data?.firstRun && await context.redis.exists(recentlyRunKey)) {
        return;
    }

    const firstCleanupDate = new Date(items[0].score);

    await context.redis.set(recentlyRunKey, "true", { expiration: addSeconds(new Date(), 30) });

    // Check platform is up.
    await context.reddit.getAppUser();

    let deletedCount = 0;
    let activeCount = 0;
    let suspendedCount = 0;
    let totalProcessed = 0;

    // Get the first N accounts that are due a check.
    const usersToCheck = items.map(item => item.member);
    while (usersToCheck.length > 0 && new Date() < runLimit && totalProcessed < 10) {
        const username = usersToCheck.shift();
        if (!username) {
            break;
        }

        totalProcessed++;

        // Push forward cleanup by one day in case retrieving user fails catastrophically.
        await setCleanupForUser(username, context.redis, addDays(new Date(), 1));

        const currentUserStatus = await userActive(username, context);

        if (currentUserStatus === UserActiveStatus.Deleted) {
            await handleDeletedAccount(username, context);
            deletedCount++;
            continue;
        }

        // If we're on a client subreddit, no need to do further checks.
        if (context.subredditName !== CONTROL_SUBREDDIT) {
            await setCleanupForUser(username, context.redis);
            continue;
        }

        let overrideCleanupDate: Date | undefined;
        const currentStatus = await getUserStatus(username, context);

        // If no current status is defined, then this entry should not have been reached.
        if (!currentStatus) {
            const submitterOrModFlag = await context.redis.zScore(SUB_OR_MOD_LOG_KEY, username);
            if (submitterOrModFlag) {
                console.log(`Cleanup: ${username} has no status, but was in submitter or mod log.`);
                await setCleanupForUser(username, context.redis);
                continue;
            }
            console.log(`Cleanup: No status for ${username}, but was in cleanup queue.`);
            await context.redis.zRem(CLEANUP_LOG_KEY, [username]);
            continue;
        }

        let newFlair: PostFlairTemplate | undefined;

        if (currentUserStatus === UserActiveStatus.Active) {
            activeCount++;
            if (currentStatus.userStatus === UserStatus.Pending) {
                // User is still pending, so set the next check date to be 1 hour from now.
                overrideCleanupDate = addHours(new Date(), 1);
            } else if (currentStatus.userStatus === UserStatus.Banned && new Date(currentStatus.lastUpdate) > subDays(new Date(), 8)) {
                // Recheck banned but active users every day for the first week, then normal cadence after.
                overrideCleanupDate = addDays(new Date(), 1);
            } else if (currentStatus.userStatus === UserStatus.Purged || currentStatus.userStatus === UserStatus.Retired) {
                // User's last status was purged or retired, but user is now active again. Restore last status or Pending.
                switch (currentStatus.lastStatus) {
                    case UserStatus.Banned:
                        newFlair = PostFlairTemplate.Banned;
                        break;
                    case UserStatus.Organic:
                        newFlair = PostFlairTemplate.Organic;
                        break;
                    case UserStatus.Declined:
                        newFlair = PostFlairTemplate.Declined;
                        break;
                    case UserStatus.Service:
                        newFlair = PostFlairTemplate.Service;
                        break;
                    default:
                        newFlair = PostFlairTemplate.Pending;
                        break;
                }
            }

            if (currentStatus.userStatus === UserStatus.Inactive) {
                // Check for recent activity to potentially change status from Inactive to Pending.
                const latestContent = await getLatestContentDate(username, context);
                if (latestContent && new Date(latestContent) > subDays(new Date(), 14)) {
                    newFlair = PostFlairTemplate.Pending;
                }
            }
        } else {
            suspendedCount++;
            // User's current status is Suspended or Shadowbanned.
            if (currentStatus.userStatus === UserStatus.Pending) {
                // Users who are currently pending but where the user is suspended or shadowbanned should be set to Retired.
                newFlair = PostFlairTemplate.Retired;
            } else if (currentStatus.userStatus !== UserStatus.Purged && currentStatus.userStatus !== UserStatus.Retired) {
                // User is active in the DB, but currently suspended or shadowbanned.
                // Change the post flair to Purged.
                newFlair = PostFlairTemplate.Purged;
            } else {
                // eslint-disable-next-line @typescript-eslint/no-deprecated
                delete currentStatus.mostRecentActivity;
                await writeUserStatus(username, currentStatus, context);
            }

            // Recheck suspended users every day for the first week
            if (new Date(currentStatus.lastUpdate) > subDays(new Date(), 8)) {
                overrideCleanupDate = addDays(new Date(), 1);
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-deprecated
        if (currentStatus.mostRecentActivity) {
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            delete currentStatus.mostRecentActivity;
            await writeUserStatus(username, currentStatus, context);
        }

        await setCleanupForUser(username, context.redis, overrideCleanupDate);

        if (newFlair) {
            await context.reddit.setPostFlair({
                postId: currentStatus.trackingPostId,
                subredditName: CONTROL_SUBREDDIT,
                flairTemplateId: newFlair,
            });
        }
    }

    let message = `Cleanup: Active ${activeCount}, Deleted ${deletedCount}, Suspended ${suspendedCount}.`;
    if (firstCleanupDate < subMinutes(new Date(), 2)) {
        message += ` Backlogged: ${formatTimeSince(firstCleanupDate)}.`;
    }

    console.log(message);

    if (usersToCheck.length > 0) {
        await context.scheduler.runJob({
            name: UniversalJob.Cleanup,
            runAt: addSeconds(new Date(), 2),
        });
    } else {
        await context.redis.del(recentlyRunKey);
    }
}

async function handleDeletedAccount (username: string, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleDeletedAccountControlSub(username, context);
    } else {
        await handleDeletedAccountClientSub(username, context.redis);
    }

    await context.redis.zRem(CLEANUP_LOG_KEY, [username]);
}

async function handleDeletedAccountControlSub (username: string, context: TriggerContext) {
    const status = await getUserStatus(username, context);
    const submitterOrModFlag = await context.redis.zScore(SUB_OR_MOD_LOG_KEY, username);

    if (!status && !submitterOrModFlag) {
        console.log(`Cleanup: ${username} has no status to delete.`);
        return;
    }

    const txn = await context.redis.watch();
    await txn.multi();

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
            await updateAggregate(status.userStatus, -1, txn);
            await updateAggregate(newStatus, 1, txn);
            console.log(`Cleanup: Aggregate for ${status.userStatus} decremented, ${newStatus} incremented for ${username}`);
        }

        try {
            const post = await context.reddit.getPostById(status.trackingPostId);
            if (post.authorName === context.appSlug) {
                await post.delete();
                const deletedPosts = await context.redis.incrBy("deletedPosts", 1);
                console.log(`Cleanup: Post deleted for ${username}. Now deleted ${deletedPosts} posts.`);

                if (status.userStatus !== newStatus) {
                    await txn.set(`ignoreflairchange:${post.id}`, "true", { expiration: addHours(new Date(), 1) });

                    await context.reddit.setPostFlair({
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
        await removeRecordOfSubmitterOrMod(username, context);
        await txn.zRem(SUB_OR_MOD_LOG_KEY, [username]);
    }

    await txn.exec();
    await deleteUserStatus(username, context);
}

async function handleDeletedAccountClientSub (username: string, redis: RedisClient) {
    await removeRecordOfBan(username, redis);
    await removeWhitelistUnban(username, redis);
    await redis.del(`removed:${username}`, `removedItems:${username}`, `lockedItems:${username}`);
}

async function getLatestContentDate (username: string, context: JobContext): Promise<number | undefined> {
    let content: (Post | Comment)[];
    try {
        content = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
        }).all();
    } catch {
        return;
    }

    return _.max(content.map(content => content.createdAt.getTime()));
}
