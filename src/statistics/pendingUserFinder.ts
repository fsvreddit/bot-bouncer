import { JobContext } from "@devvit/public-api";
import { UserDetails, UserStatus } from "../dataStore.js";
import { format, subDays } from "date-fns";
import json2md from "json2md";

export async function pendingUserFinder (allEntries: [string, UserDetails][], context: JobContext) {
    const cutoff = subDays(new Date(), 2).getTime();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const pendingUsersOverOneDay = allEntries.filter(([_, userDetails]) => userDetails.userStatus === UserStatus.Pending && (userDetails.lastUpdate < cutoff || (userDetails.reportedAt ?? 0 < cutoff)));
    if (pendingUsersOverOneDay.length === 0) {
        return;
    }

    const modQueue = await context.reddit.getModQueue({
        subreddit: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        type: "post",
        limit: 1000,
    }).all();

    const nonQueuedItems = pendingUsersOverOneDay.filter(item => !modQueue.some(queuedItem => queuedItem.id === item[1].trackingPostId));
    if (nonQueuedItems.length === 0) {
        return;
    }

    const lastReportSentKey = "pendingUsersReportSent";
    const lastReportVal = await context.redis.get(lastReportSentKey);
    if (lastReportVal && parseInt(lastReportVal, 10) > subDays(new Date(), 1).getTime()) {
        return; // Report already sent in the last 24 hours
    }

    const output: json2md.DataObject[] = [
        { p: "Some users have been in 'Pending' for two days without being in the mod queue. Please take a look and classify as needed" },
        { p: "This can happen due to a crash in the app or a user's shadowban or suspension being lifted." },
    ];

    const tableRows: string[][] = [];
    for (const [username, userDetails] of nonQueuedItems) {
        tableRows.push([
            `/u/${username}`,
            `[link](https://redd.it/${userDetails.trackingPostId.substring(3)})`,
            userDetails.reportedAt ? format(userDetails.reportedAt, "yyyy-MM-dd") : "",
        ]);
    }

    output.push({ table: { headers: ["User", "Tracking Post", "Originally Reported At"], rows: tableRows } });

    await context.reddit.modMail.createModInboxConversation({
        subject: "Pending Users Report",
        bodyMarkdown: json2md(output),
        subredditId: context.subredditId,
    });

    await context.redis.set(lastReportSentKey, Date.now().toString());
}
