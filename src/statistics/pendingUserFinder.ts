import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getFullDataStore, UserStatus } from "../dataStore.js";
import { addDays, addHours, addMinutes, format, subDays } from "date-fns";
import json2md from "json2md";
import { StatsUserEntry } from "../scheduler/sixHourlyJobs.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";
import { getUsernameFromUrl } from "../utility.js";
import _ from "lodash";
import pluralize from "pluralize";

export async function pendingUserFinder (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const jobGuid = event.data?.jobGuid as string | undefined;
    if (jobGuid && await hasTriggerBeenHandled(context.redis, `job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Pending User Finder: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const runRecentlyKey = "pendingUserFinderLastRunValue";
    if (await context.redis.exists(runRecentlyKey)) {
        console.log("Pending User Finder: Job has run recently, skipping this run.");
        return;
    }

    await context.redis.set(runRecentlyKey, "true", { expiration: addHours(new Date(), 1) });

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

    const lastReportSentKey = "pendingUsersReportSentRecentlyValue";
    const lastReportVal = await context.redis.get(lastReportSentKey);
    if (lastReportVal && parseInt(lastReportVal, 10) > subDays(new Date(), 1).getTime()) {
        console.log("Pending User Finder: Report has been sent in the last 24 hours, skipping sending another report.");
        return; // Report already sent in the last 24 hours
    }

    const output: json2md.DataObject[] = [
        { p: `${pendingUsersNotInQueue.length} ${pluralize("user", pendingUsersNotInQueue.length)} are in 'Pending' without being in the mod queue. Please take a look and classify as needed.` },
        { p: "This can happen due to a crash in the app or a user's shadowban or suspension being lifted." },
    ];

    const tableRows: string[][] = [];
    for (const item of pendingUsersNotInQueue) {
        tableRows.push([
            `/u/${item.username}`,
            `[link](https://redd.it/${item.data.trackingPostId.substring(3)})`,
            item.data.reportedAt ? format(item.data.reportedAt, "yyyy-MM-dd") : "",
        ]);
    }

    output.push({ table: { headers: ["User", "Tracking Post", "Originally Reported At"], rows: tableRows } });

    await context.reddit.modMail.createModInboxConversation({
        subject: "Pending Users Report",
        bodyMarkdown: json2md(output),
        subredditId: context.subredditId,
    });

    console.log(`Pending User Finder: Report sent for ${pendingUsersNotInQueue.length} pending users not in mod queue.`);

    await context.redis.set(lastReportSentKey, Date.now().toString(), { expiration: addDays(new Date(), 7) });
}
