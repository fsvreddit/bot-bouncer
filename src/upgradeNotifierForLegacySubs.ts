import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { ExternalSubmission, getSubredditsFromExternalSubmissions } from "./externalSubmissions.js";
import { addMinutes, format } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import json2md from "json2md";

const UPDATE_AVAILABLE_SENT_KEY = "LegacySubUpgradeNotificationAvailableSent";
const UPDATE_AVAILABLE_QUEUE_KEY = "LegacySubUpgradeNotificationAvailableQueue";

export async function queueUpgradeNotificationsForLegacySubs (externalSubmissions: ExternalSubmission[], context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Legacy Sub Upgrade Notifications are only run in the control subreddit.");
    }

    const subreddits = await getSubredditsFromExternalSubmissions(externalSubmissions, context);
    for (const subreddit of subreddits) {
        const alreadySent = await context.redis.hGet(UPDATE_AVAILABLE_SENT_KEY, subreddit);
        if (!alreadySent) {
            await context.redis.zAdd(UPDATE_AVAILABLE_QUEUE_KEY, { member: subreddit, score: Date.now() });
            console.log(`Upgrade Notifier for Legacy Subs: Queued upgrade notification for /r/${subreddit}`);
        } else {
            console.log(`Upgrade Notifier for Legacy Subs: Notification already sent to /r/${subreddit} on ${format(new Date(parseInt(alreadySent)), "yyyy-MM-dd")}, skipping.`);
        }
    }
}

export async function processLegacySubUpgradeNotifications (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Legacy Sub Upgrade Notifications are only run in the control subreddit.");
    }

    const recentlyRunKey = "legacySubUpgradeNotificationsLastRun";
    if (event.data?.firstRun && await context.redis.exists(recentlyRunKey)) {
        console.log("Upgrade Notifier for Legacy Subs: Recently run, skipping this execution.");
        return;
    }

    await context.redis.set(recentlyRunKey, "true", { expiration: addMinutes(new Date(), 5) });

    const { subredditName, inBacklog } = await context.redis.zRange(UPDATE_AVAILABLE_QUEUE_KEY, 0, 1)
        .then((items) => {
            if (items.length === 0) {
                return { subredditName: undefined, inBacklog: false };
            }
            return { subredditName: items[0].member, inBacklog: items.length > 1 };
        });

    if (!subredditName) {
        return;
    }

    await context.redis.zRem(UPDATE_AVAILABLE_QUEUE_KEY, [subredditName]);

    await sendNotificationToLegacySub(subredditName, context);

    if (inBacklog) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.CheckUpgradeNotifierForLegacySubs,
            runAt: addMinutes(new Date(), 1),
            data: { firstRun: false },
        });
    }
}

async function sendNotificationToLegacySub (subredditName: string, context: JobContext) {
    const message: json2md.DataObject[] = [
        { p: `Hello! It looks like you have an old version of Bot Bouncer installed on /r/${subredditName}. This version may be missing newer bot detection code and reacts slower to newly configured detections.` },
        { p: `To upgrade to the latest version of Bot Bouncer, visit [this page](https://developers.reddit.com/r/${subredditName}/apps).` },
        { p: "You can also configure automatic update notifications from the Bot Bouncer configuration page after upgrading." },
        { p: "*This is an automated message, replies will not be read. If you have any questions, please modmail /r/BotBouncer.*" },
    ];

    await context.reddit.sendPrivateMessage({
        to: `/r/${subredditName}`,
        subject: "Upgrade available for Bot Bouncer",
        text: json2md(message),
    });

    await context.redis.hSet(UPDATE_AVAILABLE_SENT_KEY, { [subredditName]: Date.now().toString() });
}
