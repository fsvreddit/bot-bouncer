import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addMinutes, addSeconds, format, subDays, subWeeks } from "date-fns";
import json2md from "json2md";
import { getFullDataStore } from "../../dataStore";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { StatsUserEntry } from "./statsHelpers";
import { CONTROL_SUBREDDIT, ControlSubredditJob, getUsernameFromUrl } from "../..";
import pluralize from "pluralize";
import { regenerateSummary } from "../userSummary";
import { CreateSummariesForPendingUsersJobData, PendingUserFinderJobData } from "../../../tasks";
import { compact } from "lodash-es";

const PENDING_USER_WIKI_PAGE = "pending-users";
const PENDING_USERS_TO_ALERT_KEY = "pendingUsersToAlert";

export async function pendingUserFinder (event: TaskRequest<PendingUserFinderJobData | undefined>) {
    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Pending User Finder: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const allData = await getFullDataStore({
        statuses: [UserStatus.Pending],
    });

    const pendingUsers = Object.entries(allData)
        .filter(([, value]) => value.userStatus === UserStatus.Pending)
        .map(([key, value]) => ({ username: key, data: value } satisfies StatsUserEntry));

    if (pendingUsers.length === 0) {
        console.log("Pending User Finder: No pending users found.");
        return;
    }

    const usersInModQueue = await reddit.getModQueue({
        subreddit: context.subredditName,
        limit: 1000,
        type: "post",
    }).all().then(posts => new Set(compact(posts.map(post => getUsernameFromUrl(post.url)))));

    const pendingUsersNotInQueue = pendingUsers.filter(user => !usersInModQueue.has(user.username));

    if (pendingUsersNotInQueue.length === 0) {
        console.log(`Pending User Finder: All ${pendingUsers.length} pending users are in the mod queue.`);
        return;
    }

    const userData = pendingUsersNotInQueue.map(user => ({ username: user.username, postId: user.data.trackingPostId }));

    await reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: PENDING_USER_WIKI_PAGE,
        content: JSON.stringify(userData),
    });

    await scheduler.runJob<CreateSummariesForPendingUsersJobData>({
        name: ControlSubredditJob.CreateSummaries,
        runAt: new Date(),
        data: {
            jobGuid: crypto.randomUUID(),
            userData,
        },
    });

    const lastReportSentKey = "pendingUsersReportSentRecentlyValue";
    const lastReportVal = await redis.get(lastReportSentKey);
    if (lastReportVal && parseInt(lastReportVal, 10) > subDays(new Date(), 1).getTime()) {
        console.log("Pending User Finder: Report has been sent in the last 24 hours, skipping sending another report.");
        return; // Report already sent in the last 24 hours
    }

    const output: json2md.DataObject[] = [
        { p: `${pendingUsersNotInQueue.length} ${pluralize("user", pendingUsersNotInQueue.length)} ${pluralize("has", pendingUsersNotInQueue.length)} a status of 'pending' without being in the mod queue. Please take a look and classify as needed.` },
        { p: "This can happen due to a crash in the app or a user's shadowban or suspension being lifted." },
    ];

    // Clear out entries over a week.
    await redis.zRemRangeByScore(PENDING_USERS_TO_ALERT_KEY, 0, subWeeks(new Date(), 1).getTime());
    const duePendingUsers = new Set(await redis.zRange(PENDING_USERS_TO_ALERT_KEY, Date.now(), "+inf", { by: "score" }).then(entries => entries.map(entry => entry.member)));

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

    await reddit.modMail.createModInboxConversation({
        subject: "Pending Users Report",
        bodyMarkdown: json2md(output),
        subredditId: context.subredditId,
    });

    console.log(`Pending User Finder: Report sent for ${pendingUsersNotInQueue.length} pending users not in mod queue.`);

    await redis.set(lastReportSentKey, Date.now().toString(), { expiration: addDays(new Date(), 7) });
}

export async function createSummariesForPendingUsers (event: TaskRequest<CreateSummariesForPendingUsersJobData>) {
    if (await hasEventBeenHandled(`job:${event.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
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

    const post = await reddit.getPostById(entry.postId as T3);
    await regenerateSummary(entry.username, post);

    if (!await redis.zScore(PENDING_USERS_TO_ALERT_KEY, entry.username)) {
        await redis.zAdd(PENDING_USERS_TO_ALERT_KEY, { member: entry.username, score: addDays(new Date(), 1).getTime() });
    }

    if (userData.length > 0) {
        await scheduler.runJob<CreateSummariesForPendingUsersJobData>({
            name: ControlSubredditJob.CreateSummaries,
            runAt: addSeconds(new Date(), 5),
            data: {
                jobGuid: crypto.randomUUID(),
                userData,
            },
        });
    }
}
