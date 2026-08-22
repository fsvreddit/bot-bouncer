import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getFullDataStore } from "../dataStore.js";
import { addDays, addMinutes, addSeconds, format, subDays, subWeeks } from "date-fns";
import json2md from "json2md";
import { StatsUserEntry } from "../scheduler/sixHourlyJobs.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";
import { getUsernameFromUrl } from "../utility.js";
import _ from "lodash";
import pluralize from "pluralize";
import { UserStatus } from "../types.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { regenerateSummary } from "../UserSummary/userSummary.js";

const PENDING_USER_WIKI_PAGE = "pending-users";
const PENDING_USERS_TO_ALERT_KEY = "pendingUsersToAlert";

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type PendingUserFinderJobData = {
    jobGuid: string;
    userData: {
        username: string;
        postId: string;
    }[];
};

export async function pendingUserFinder (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const jobGuid = event.data?.jobGuid as string | undefined;
    if (jobGuid && await hasTriggerBeenHandled(context.redis, `job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Pending User Finder: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const allData = await getFullDataStore(context, {
        statuses: [UserStatus.Pending],
    });

    const pendingUsers = Object.entries(allData)
        .filter(([, value]) => value.userStatus === UserStatus.Pending)
        .map(([key, value]) => ({ username: key, data: value } satisfies StatsUserEntry));

    if (pendingUsers.length === 0) {
        console.log("Pending User Finder: No pending users found.");
        return;
    }

    const usersInModQueue = await context.reddit.getModQueue({
        subreddit: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        limit: 1000,
        type: "post",
    }).all().then(posts => new Set(_.compact(posts.map(post => getUsernameFromUrl(post.url)))));

    const pendingUsersNotInQueue = pendingUsers.filter(user => !usersInModQueue.has(user.username));

    if (pendingUsersNotInQueue.length === 0) {
        console.log(`Pending User Finder: All ${pendingUsers.length} pending users are in the mod queue.`);
        return;
    }

    const userData = pendingUsersNotInQueue.map(user => ({ username: user.username, postId: user.data.trackingPostId }));

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: PENDING_USER_WIKI_PAGE,
        content: JSON.stringify(userData),
    });

    await context.scheduler.runJob({
        name: ControlSubredditJob.CreateSummaries,
        runAt: new Date(),
        data: {
            jobGuid: crypto.randomUUID(),
            userData,
        } satisfies PendingUserFinderJobData,
    });

    const lastReportSentKey = "pendingUsersReportSentRecentlyValue";
    const lastReportVal = await context.redis.get(lastReportSentKey);
    if (lastReportVal && parseInt(lastReportVal, 10) > subDays(new Date(), 1).getTime()) {
        console.log("Pending User Finder: Report has been sent in the last 24 hours, skipping sending another report.");
        return; // Report already sent in the last 24 hours
    }

    const output: json2md.DataObject[] = [
        { p: `${pendingUsersNotInQueue.length} ${pluralize("user", pendingUsersNotInQueue.length)} ${pluralize("is", pendingUsersNotInQueue.length)} with a status of 'pending' without being in the mod queue. Please take a look and classify as needed.` },
        { p: "This can happen due to a crash in the app or a user's shadowban or suspension being lifted." },
    ];

    // Clear out entries over a week.
    await context.redis.zRemRangeByScore(PENDING_USERS_TO_ALERT_KEY, 0, subWeeks(new Date(), 1).getTime());
    const duePendingUsers = new Set(await context.redis.zRange(PENDING_USERS_TO_ALERT_KEY, Date.now(), "+inf", { by: "score" }).then(entries => entries.map(entry => entry.member)));

    const tableRows: string[][] = [];
    for (const item of pendingUsersNotInQueue) {
        if (duePendingUsers.has(item.username)) {
            tableRows.push([
                `/u/${item.username}`,
                `[link](https://redd.it/${item.data.trackingPostId.substring(3)})`,
                item.data.reportedAt ? format(item.data.reportedAt, "yyyy-MM-dd") : "",
            ]);
        }
    }

    if (tableRows.length === 0) {
        console.log("Pending User Finder: No pending users are due for alerting, skipping sending report.");
        return;
    }

    output.push({ table: { headers: ["User", "Tracking Post", "Originally Reported At"], rows: tableRows } });

    await context.reddit.modMail.createModInboxConversation({
        subject: "Pending Users Report",
        bodyMarkdown: json2md(output),
        subredditId: context.subredditId as `t5_${string}`,
    });

    console.log(`Pending User Finder: Report sent for ${pendingUsersNotInQueue.length} pending users not in mod queue.`);

    await context.redis.set(lastReportSentKey, Date.now().toString(), { expiration: addDays(new Date(), 7) });
}

export async function createSummariesForPendingUsers (event: ScheduledJobEvent<PendingUserFinderJobData>, context: JobContext) {
    if (await hasTriggerBeenHandled(context.redis, `job:${event.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Create Summaries for Pending Users: Job with guid ${event.data.jobGuid} has already been handled, skipping.`);
        return;
    }

    const userData = event.data.userData;
    if (userData.length === 0) {
        console.log("Create Summaries for Pending Users: No user data provided, skipping.");
        return;
    }

    const entry = userData.shift();
    if (!entry) {
        return;
    }

    const post = await context.reddit.getPostById(entry.postId);
    await regenerateSummary(entry.username, post, context);

    if (!await context.redis.zScore(PENDING_USERS_TO_ALERT_KEY, entry.username)) {
        await context.redis.zAdd(PENDING_USERS_TO_ALERT_KEY, { member: entry.username, score: addDays(new Date(), 1).getTime() });
    }

    if (userData.length > 0) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.CreateSummaries,
            runAt: addSeconds(new Date(), 5),
            data: {
                jobGuid: crypto.randomUUID(),
                userData,
            } satisfies PendingUserFinderJobData,
        });
    }
}
