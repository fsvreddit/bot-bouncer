import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { ExternalSubmission, getSubredditsFromExternalSubmissions } from "./externalSubmissions.js";
import { hasPermissions, isModerator } from "devvit-helpers";
import json2md from "json2md";
import pluralize from "pluralize";

const PERMISSION_CHECKS_QUEUE = "permissionChecksQueue";
const PERMISSION_MESSAGE_SENT_HASH = "permissionsMessageSent";

export async function handlePermissionCheckEnqueueJob (_: unknown, context: JobContext) {
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    if (subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Permission check enqueue job should not run on control subreddit");
    }

    await addSubToPermissionChecksQueue(subredditName, context);
}

async function addSubToPermissionChecksQueue (subredditName: string, context: TriggerContext | JobContext) {
    const recentCheckKey = `permissionCheckedRecently:${subredditName}`;
    if (await context.redis.global.get(recentCheckKey)) {
        console.log(`Permission Checks: Recently checked /r/${subredditName}, skipping enqueue.`);
        return;
    }

    await context.redis.global.zAdd(PERMISSION_CHECKS_QUEUE, { member: subredditName, score: Date.now() });
    await context.redis.global.set(recentCheckKey, "true", { expiration: addDays(new Date(), 7) });
    console.log(`Permission Checks: Added /r/${subredditName} to permission checks queue.`);
}

export async function addSubsToPermissionChecksQueueFromExternalSubmissions (externalSubmissions: ExternalSubmission[], context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("addSubsToPermissionChecksQueueFromExternalSubmissions should only be called from control subreddit");
    }

    const subreddits = await getSubredditsFromExternalSubmissions(externalSubmissions, context);

    await Promise.all(subreddits.map(subreddit => addSubToPermissionChecksQueue(subreddit, context)));
    console.log(`Permission Checks: Added ${subreddits.length} ${pluralize("subreddit", subreddits.length)} to permission checks queue from external submissions.`);
}

export async function checkPermissionQueueItems (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("checkPermissionQueueItems should only be called from control subreddit");
    }

    const recentlyRunKey = "permissionChecksLastRun";
    if (event.data?.firstRun && await context.redis.exists(recentlyRunKey)) {
        console.log("Permission Checks: Recently run, skipping this execution.");
        return;
    }

    const { subredditName, inBacklog } = await context.redis.global.zRange(PERMISSION_CHECKS_QUEUE, 0, 1)
        .then((items) => {
            if (items.length === 0) {
                return { subredditName: undefined, inBacklog: false };
            }

            return { subredditName: items[0].member, inBacklog: items.length > 1 };
        });

    if (!subredditName) {
        return;
    }

    await context.redis.set(recentlyRunKey, "true", { expiration: addMinutes(new Date(), 1) });

    const problemFound: json2md.DataObject[] = [];

    await context.redis.global.zRem(PERMISSION_CHECKS_QUEUE, [subredditName]);

    const isMod = await isModerator(context.reddit, subredditName, context.appName);

    if (!isMod) {
        problemFound.push([
            { p: `/u/bot-bouncer is not a moderator of ${subredditName}. This means that most functions of Bot Bouncer will not work correctly.` },
            { p: `Unfortunately it is not possible to add Dev Platform apps back as moderators once they have been removed. ` },
            { p: `Please **uninstall Bot Bouncer** from your subreddit's [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/bot-bouncer), it can then be reinstalled from the [app directory page](https://developers.reddit.com/apps/${context.appName}) if you wish to continue using the service.` },
        ]);
    } else {
        const hasPerms = await hasPermissions(context.reddit, {
            subredditName,
            username: context.appName,
            requiredPerms: ["access", "posts", "mail"],
        });

        if (!hasPerms) {
            problemFound.push([
                { p: `/u/bot-bouncer does not have all required moderator permissions in ${subredditName} to work correctly.` },
                { p: `Dev Platform apps must have full moderator permissions to work properly, so please update the app's moderator permissions.` },
            ]);
        }
    }

    if (problemFound.length === 0) {
        console.log(`Permission Checks: ${subredditName} passed permission checks.`);
        await context.redis.hDel(PERMISSION_MESSAGE_SENT_HASH, [subredditName]);
        if (inBacklog) {
            await context.scheduler.runJob({
                name: ControlSubredditJob.CheckPermissionQueueItems,
                runAt: addSeconds(new Date(), 2),
                data: { firstRun: false },
            });
        }
        return;
    }

    if (await context.redis.hGet(PERMISSION_MESSAGE_SENT_HASH, subredditName)) {
        console.log(`Permission Checks: Permissions message already sent to ${subredditName}, skipping check.`);
        if (inBacklog) {
            await context.scheduler.runJob({
                name: ControlSubredditJob.CheckPermissionQueueItems,
                runAt: addSeconds(new Date(), 2),
                data: { firstRun: false },
            });
        }
        return;
    }

    const messageSubject = "Bot Bouncer: Moderator Permissions Issue Detected";
    const message: json2md.DataObject[] = [
        { p: `Hello! During a recent check, Bot Bouncer detected that there is a problem with its moderator permissions in your subreddit, /r/${subredditName}. As a result, some or all of the bot's functionality may not work correctly.` },
        ...problemFound,
        { p: `If you have any questions or need assistance, please message the mods of /r/BotBouncer.` },
        { p: `*This is an automated message, replies will not be read. You won't receive another notification about this issue unless the permissions change.` },
    ];

    await context.reddit.sendPrivateMessage({
        to: `/r/${subredditName}`,
        subject: messageSubject,
        text: json2md(message),
    });

    await context.redis.hSet(PERMISSION_MESSAGE_SENT_HASH, { [subredditName]: "true" });
    console.log(`Permission Checks: Sent permissions issue message to /r/${subredditName}.`);

    if (inBacklog) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.CheckPermissionQueueItems,
            runAt: addSeconds(new Date(), 30),
            data: { firstRun: false },
        });
    }
}
