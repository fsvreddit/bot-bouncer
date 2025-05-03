import { Comment, JobContext, Post, TriggerContext } from "@devvit/public-api";
import { addDays, addHours, addSeconds, format, subDays } from "date-fns";
import { CONTROL_SUBREDDIT, PostFlairTemplate, UniversalJob } from "./constants.js";
import { deleteUserStatus, getUserStatus, removeRecordOfSubmitterOrMod, updateAggregate, UserStatus, writeUserStatus } from "./dataStore.js";
import { getUserOrUndefined } from "./utility.js";
import { removeRecordOfBan, removeWhitelistUnban } from "./handleClientSubredditWikiUpdate.js";
import { max } from "lodash";

const CLEANUP_LOG_KEY = "CleanupLog";
const SUB_OR_MOD_LOG_KEY = "SubOrModLog";
const DAYS_BETWEEN_CHECKS = 7;

export async function setCleanupForUser (username: string, context: TriggerContext, controlSubOnly?: boolean, overrideDate?: Date) {
    if (controlSubOnly && context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    const cleanupTime = overrideDate ?? addDays(new Date(), DAYS_BETWEEN_CHECKS);

    await context.redis.zAdd(CLEANUP_LOG_KEY, ({ member: username, score: cleanupTime.getTime() }));
}

export async function setCleanupForSubmittersAndMods (usernames: string[], context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    if (usernames.length === 0) {
        return;
    }

    await context.redis.zAdd(SUB_OR_MOD_LOG_KEY, ...usernames.map(username => ({ member: username, score: new Date().getTime() })));
    await Promise.all(usernames.map(username => setCleanupForUser(username, context, true)));
}

enum UserActiveStatus {
    Active = "active",
    Deleted = "deleted",
    Suspended = "suspended",
}

async function userActive (username: string, context: TriggerContext): Promise<UserActiveStatus> {
    const user = await getUserOrUndefined(username, context);
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

export async function cleanupDeletedAccounts (_: unknown, context: JobContext) {
    const items = await context.redis.zRange(CLEANUP_LOG_KEY, 0, new Date().getTime(), { by: "score" });
    if (items.length === 0) {
        // No user accounts need to be checked.
        console.log("Cleanup: No users to check.");
        return;
    }

    // Check platform is up.
    await context.reddit.getAppUser();

    const itemsToCheck = 5;

    let deletedCount = 0;
    let activeCount = 0;
    let suspendedCount = 0;
    // Get the first N accounts that are due a check.
    const usersToCheck = items.slice(0, itemsToCheck).map(item => item.member);
    for (const username of usersToCheck) {
        const currentUserStatus = await userActive(username, context);

        if (currentUserStatus === UserActiveStatus.Deleted) {
            await handleDeletedAccount(username, context);
            deletedCount++;
            continue;
        }

        // If we're on a client subreddit, no need to do further checks.
        if (context.subredditName !== CONTROL_SUBREDDIT) {
            await setCleanupForUser(username, context, false);
            continue;
        }

        let overrideCleanupDate: Date | undefined;
        const currentStatus = await getUserStatus(username, context);

        // If no current status is defined, then this entry should not have been reached.
        if (!currentStatus) {
            const submitterOrModFlag = await context.redis.zScore(SUB_OR_MOD_LOG_KEY, username);
            if (submitterOrModFlag) {
                console.log(`Cleanup: ${username} has no status, but was in submitter or mod log.`);
                await setCleanupForUser(username, context, true);
                continue;
            }
            console.log(`Cleanup: No status for ${username}, but was in cleanup queue.`);
            await context.redis.zRem(CLEANUP_LOG_KEY, [username]);
            continue;
        }

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
                let newTemplate: PostFlairTemplate;
                switch (currentStatus.lastStatus) {
                    case UserStatus.Banned:
                        newTemplate = PostFlairTemplate.Banned;
                        break;
                    case UserStatus.Organic:
                        newTemplate = PostFlairTemplate.Organic;
                        break;
                    case UserStatus.Service:
                        newTemplate = PostFlairTemplate.Service;
                        break;
                    default:
                        newTemplate = PostFlairTemplate.Pending;
                        break;
                }

                await context.reddit.setPostFlair({
                    postId: currentStatus.trackingPostId,
                    subredditName: CONTROL_SUBREDDIT,
                    flairTemplateId: newTemplate,
                });
            }

            const latestActivity = await getLatestContentDate(username, context) ?? currentStatus.reportedAt;
            if (latestActivity) {
                // Store the latest activity date.
                currentStatus.mostRecentActivity = latestActivity;
                await writeUserStatus(username, currentStatus, context);
                console.log(`Cleanup: ${username} last activity: ${format(latestActivity, "yyyy-MM-dd")}`);
            } else {
                console.log(`Cleanup: Unable to get latest activity for ${username}`);
            }
        } else {
            suspendedCount++;
            // User's current status is Suspended or Shadowbanned.
            if (currentStatus.userStatus === UserStatus.Pending) {
                // Users who are currently pending but where the user is suspended or shadowbanned should be set to Retired.
                await context.reddit.setPostFlair({
                    postId: currentStatus.trackingPostId,
                    subredditName: CONTROL_SUBREDDIT,
                    flairTemplateId: PostFlairTemplate.Retired,
                });
            } else if (currentStatus.userStatus !== UserStatus.Purged && currentStatus.userStatus !== UserStatus.Retired) {
                // User is active in the DB, but currently suspended or shadowbanned.
                // Change the post flair to Purged.
                await context.reddit.setPostFlair({
                    postId: currentStatus.trackingPostId,
                    subredditName: CONTROL_SUBREDDIT,
                    flairTemplateId: PostFlairTemplate.Purged,
                });
            } else {
                await writeUserStatus(username, currentStatus, context);
            }

            // Recheck suspended users every day for the first week
            if (new Date(currentStatus.lastUpdate) > subDays(new Date(), 8)) {
                overrideCleanupDate = addDays(new Date(), 1);
            } else if (new Date(currentStatus.lastUpdate) < subDays(new Date(), 28)) {
                // If the user has been suspended for more than 28 days, set the cleanup date to 28 days from now.
                overrideCleanupDate = addDays(new Date(), 28);
            }
        }

        await setCleanupForUser(username, context, false, overrideCleanupDate);
    }

    console.log(`Cleanup: Active ${activeCount}, Deleted ${deletedCount}, Suspended ${suspendedCount}`);

    if (items.length > itemsToCheck) {
        // In a backlog, so force another run.
        await context.scheduler.runJob({
            name: UniversalJob.Cleanup,
            runAt: addSeconds(new Date(), 2),
        });
    }
}

async function handleDeletedAccount (username: string, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleDeletedAccountControlSub(username, context);
    } else {
        await handleDeletedAccountClientSub(username, context);
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
                return;
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

    await deleteUserStatus(username, context);
}

async function handleDeletedAccountClientSub (username: string, context: TriggerContext) {
    await Promise.all([
        removeRecordOfBan(username, context),
        removeWhitelistUnban(username, context),
        context.redis.del(`removed:${username}`),
        context.redis.del(`removedItems:${username}`),
    ]);
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

    return max(content.map(content => content.createdAt.getTime()));
}
