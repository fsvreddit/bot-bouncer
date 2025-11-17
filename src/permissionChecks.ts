import { JobContext, TriggerContext } from "@devvit/public-api";
import { addDays } from "date-fns";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { ExternalSubmission } from "./externalSubmissions.js";
import { getPostOrCommentById } from "./utility.js";
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

async function addSubToPermissionChecksQueue (subredditName: string, context: TriggerContext) {
    const recentCheckKey = `permissionCheckedRecently:${subredditName}`;
    if (await context.redis.global.get(recentCheckKey)) {
        return;
    }

    await context.redis.global.zAdd(PERMISSION_CHECKS_QUEUE, { member: subredditName, score: Date.now() });
    await context.redis.global.set(recentCheckKey, "true", { expiration: addDays(new Date(), 1) });
    console.log(`Permission Checks: Added /r/${subredditName} to permission checks queue.`);
}

export async function addSubsToPermissionChecksQueueFromExternalSubmissions (externalSubmissions: ExternalSubmission[], context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("addSubsToPermissionChecksQueueFromExternalSubmissions should only be called from control subreddit");
    }

    const subreddits = new Set<string>();

    for (const submission of externalSubmissions) {
        let itemAdded = false;
        if (submission.reportContext) {
            const regex = /^Automatically reported via a (?:post|comment) on \/r\/([A-Za-z_-]{3,21})$/;
            const match = regex.exec(submission.reportContext);
            if (match?.[1]) {
                subreddits.add(match[1]);
                itemAdded = true;
            }
        }

        if (!itemAdded && submission.targetId) {
            const target = await getPostOrCommentById(submission.targetId, context);
            subreddits.add(target.subredditName);
        }
    }

    await Promise.all(Array.from(subreddits).map(subreddit => addSubToPermissionChecksQueue(subreddit, context)));
    console.log(`Permission Checks: Added ${subreddits.size} ${pluralize("subreddit", subreddits.size)} to permission checks queue from external submissions.`);
}

export async function checkPermissionQueueItems (_: unknown, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("checkPermissionQueueItems should only be called from control subreddit");
    }

    const subredditName = await context.redis.global.zRange(PERMISSION_CHECKS_QUEUE, 0, 0)
        .then(items => items.length === 0 ? undefined : items[0].member);

    if (!subredditName) {
        return;
    }

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
        return;
    }

    if (await context.redis.hGet(PERMISSION_MESSAGE_SENT_HASH, subredditName)) {
        console.log(`Permission Checks: Permissions message already sent to ${subredditName}, skipping check.`);
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
}
