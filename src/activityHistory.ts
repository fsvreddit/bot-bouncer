import { Comment, JobContext, Post, TriggerContext } from "@devvit/public-api";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { addDays, addMinutes, format, subWeeks } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob, PostFlairTemplate } from "./constants.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { max } from "lodash";
import pluralize from "pluralize";

const ACTIVITY_CHECK_QUEUE = "activityCheckQueue";
const ACTIVITY_CHECK_STORE = "activityCheckStore";
const DAYS_BETWEEN_CHECKS = 8;

async function postsAndCommentsInLastWeek (username: string, context: JobContext) {
    let content: (Post | Comment)[];
    try {
        content = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
            timeframe: "week",
        }).all();
    } catch {
        return;
    }

    const commentsInLastWeek = content.filter(item => isCommentId(item.id) && item.createdAt > subWeeks(new Date(), 1));
    const postsInLastWeek = content.filter(item => isLinkId(item.id) && item.createdAt > subWeeks(new Date(), 1));

    return {
        commentsInLastWeek: commentsInLastWeek.length,
        postsInLastWeek: postsInLastWeek.length,
        latestActivity: max(commentsInLastWeek.map(item => item.createdAt).concat(postsInLastWeek.map(item => item.createdAt)))?.getTime() ?? 0,
    };
}

export async function queueUserForActivityCheck (username: string, context: JobContext, scheduleJob?: boolean) {
    await context.redis.zAdd(ACTIVITY_CHECK_QUEUE, { member: username, score: addDays(new Date(), DAYS_BETWEEN_CHECKS).getTime() });
    if (scheduleJob) {
        await scheduleAdhocActivityJob(context);
    }
}

export async function removeActivityCheckRecords (username: string, context: JobContext) {
    await context.redis.zRem(ACTIVITY_CHECK_QUEUE, [username]);
    await context.redis.hDel(ACTIVITY_CHECK_STORE, [username]);
}

interface ActivityRecord {
    commentsInLastWeek: number;
    postsInLastWeek: number;
    latestActivity: number;
    lastStatusDate?: number;
}

async function checkUserActivity (username: string, context: JobContext) {
    const currentStatus = await getUserStatus(username, context);
    if (currentStatus?.userStatus !== UserStatus.Banned && currentStatus?.userStatus !== UserStatus.Purged) {
        await removeActivityCheckRecords(username, context);
        console.log(`Activity Check: User ${username} is no longer banned. Removing from activity check queue.`);
        return;
    }

    const itemsInLastWeek = await postsAndCommentsInLastWeek(username, context);
    if (!itemsInLastWeek) {
        await queueUserForActivityCheck(username, context);
        console.log(`Activity Check: Could not retrieve data for ${username}`);
        return;
    }

    if (currentStatus.userStatus === UserStatus.Purged && currentStatus.lastStatus === UserStatus.Banned) {
        // Handle temp shadowban reactivation
        await context.reddit.setPostFlair({
            postId: currentStatus.trackingPostId,
            flairTemplateId: PostFlairTemplate.Banned,
            subredditName: CONTROL_SUBREDDIT,
        });
    }

    if (itemsInLastWeek.commentsInLastWeek > 0 || itemsInLastWeek.postsInLastWeek > 0) {
        const entryToStore: ActivityRecord = {
            ...itemsInLastWeek,
            lastStatusDate: currentStatus.lastUpdate,
        };
        await context.redis.hSet(ACTIVITY_CHECK_STORE, { [username]: JSON.stringify(entryToStore) });
        console.log(`Activity Check: User ${username} has been active recently. Comments in last week: ${itemsInLastWeek.commentsInLastWeek}, Posts in last week: ${itemsInLastWeek.postsInLastWeek}`);
    } else {
        console.log(`Activity Check: User ${username} has no activity in the last week`);
        await context.redis.hDel(ACTIVITY_CHECK_STORE, [username]);
    }

    await queueUserForActivityCheck(username, context);
}

export async function checkActivityQueue (_: unknown, context: JobContext) {
    const usersDueACheck = await context.redis.zRange(ACTIVITY_CHECK_QUEUE, 0, new Date().getTime(), { by: "score" });
    const userBatch = usersDueACheck.slice(0, 10).map(item => item.member);
    if (userBatch.length === 0) {
        await scheduleAdhocActivityJob(context);
        return;
    }

    await Promise.all(userBatch.map(username => checkUserActivity(username, context)));
    await scheduleAdhocActivityJob(context);

    console.log(`Activity Check: ${userBatch.length} ${pluralize("user", userBatch.length)} checked`);
}

async function scheduleAdhocActivityJob (context: JobContext) {
    const currentJobs = await context.scheduler.listJobs();
    if (currentJobs.some(job => job.name === ControlSubredditJob.ActivityCheck as string)) {
        return;
    }

    const firstEntry = await context.redis.zRange(ACTIVITY_CHECK_QUEUE, 0, 0);
    if (firstEntry.length === 0) {
        return;
    }

    const nextCheckDue = new Date(firstEntry[0].score);
    const nextRunDate = nextCheckDue < new Date() ? new Date() : addMinutes(nextCheckDue, 1);

    await context.scheduler.runJob({
        name: ControlSubredditJob.ActivityCheck,
        runAt: nextRunDate,
    });

    console.log(`Activity Check: Next job scheduled for ${nextRunDate.toUTCString()}`);
}

export async function createActivityLogWikiPage (context: TriggerContext) {
    const data = await context.redis.hGetAll(ACTIVITY_CHECK_STORE);
    const records = Object.entries(data)
        .map(([username, data]) => ({ username, data: JSON.parse(data) as ActivityRecord }));

    const staleRecords = records.filter(entry => entry.data.latestActivity < subWeeks(new Date(), 1).getTime());
    if (staleRecords.length > 0) {
        await context.redis.hDel(ACTIVITY_CHECK_STORE, staleRecords.map(entry => entry.username));
    }

    const freshEntries = records.filter(entry => entry.data.latestActivity > subWeeks(new Date(), 1).getTime());
    // Sort entries by the amount of posts and comments descending
    freshEntries.sort((a, b) => {
        const aTotal = a.data.commentsInLastWeek + a.data.postsInLastWeek;
        const bTotal = b.data.commentsInLastWeek + b.data.postsInLastWeek;
        return bTotal - aTotal;
    });

    let wikiContent = "This page shows the details of users who are marked as `banned` but have been active recently.\n\n";

    if (freshEntries.length === 0) {
        wikiContent += "No users have been spotted as being active recently. Data will take some time to populate.\n\n";
    } else {
        wikiContent += "| Username | Comments in last week | Posts in last week | Last activity | Last status date |\n";
        wikiContent += "| -------- | --------------------- | ------------------ | ------------- | ---------------- |\n";
        for (const entry of freshEntries) {
            const { username, data } = entry;
            const lastActivityDate = format(new Date(data.latestActivity), "yyyy-MM-dd");
            const lastStatusDate = data.lastStatusDate ? format(new Date(data.lastStatusDate), "yyyy-MM-dd") : "";
            wikiContent += `| /u/${username} | ${data.commentsInLastWeek} | ${data.postsInLastWeek} | ${lastActivityDate} | ${lastStatusDate} |\n`;
        }
    }

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/banned-user-activity",
        content: wikiContent,
    });
}
