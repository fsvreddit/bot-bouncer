import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { addDays, addHours, addMinutes, addSeconds, format, subWeeks } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import { hasPermissions, hMGetAsRecord, isModerator } from "devvit-helpers";
import json2md from "json2md";

const PERMISSION_CHECKS_QUEUE = "permissionChecksQueue";
const PERMISSION_MESSAGE_SENT_HASH = "permissionsMessageSent";
const INSTALL_DATES_KEY = "botBouncerInstallDates";
const INSTALL_DATES_LAST_CHECKED_KEY = "installDatesLastChecked";

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
    let checkSucceeded = false;
    await context.redis.global.zRem(PERMISSION_CHECKS_QUEUE, [subredditName]);

    try {
        const isMod = await isModerator(context.reddit, subredditName, context.appSlug);

        if (!isMod) {
            problemFound.push([
                { p: `/u/bot-bouncer is not a moderator of /r/${subredditName}. This means that most functions of Bot Bouncer will not work correctly.` },
                { p: `Please check that you have the latest version of Bot Bouncer on your subreddit's [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/bot-bouncer), and then re-invite /u/bot-bouncer to the mod team with full permissions` },
                { p: "If you no longer wish to use Bot Bouncer, it can be uninstalled from the same page." },
            ]);
        } else {
            const hasPerms = await hasPermissions(context.reddit, {
                subredditName,
                username: context.appSlug,
                requiredPerms: ["access", "posts", "mail"],
            });

            if (!hasPerms) {
                problemFound.push([
                    { p: `/u/bot-bouncer does not have all required moderator permissions in /r/${subredditName} to work correctly.` },
                    { p: `Dev Platform apps must have full moderator permissions to work properly. Please check the permissions and update them as needed.` },
                ]);
            }
        }
        checkSucceeded = true;
    } catch {
        console.log(`Permission Checks: Failed to check moderator status for /r/${subredditName}, assuming sub banned or platform issues.`);
    }

    if (problemFound.length === 0) {
        if (checkSucceeded) {
            console.log(`Permission Checks: ${subredditName} passed permission checks.`);
        }

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
        { p: `*This is an automated message, replies will not be read. You won't receive another notification about this issue unless the permissions change.*` },
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

    await recordInstallDate(subredditName, context);
}

async function recordInstallDate (subredditName: string, context: TriggerContext) {
    await context.redis.zAdd(INSTALL_DATES_LAST_CHECKED_KEY, { member: subredditName, score: Date.now() });
    const existingInstallDate = await context.redis.zScore(INSTALL_DATES_KEY, subredditName);
    if (existingInstallDate) {
        return;
    }

    if (await context.redis.hGet(PERMISSION_MESSAGE_SENT_HASH, subredditName)) {
        return;
    }

    await context.redis.zAdd(INSTALL_DATES_KEY, { member: subredditName, score: Date.now() });
    console.log(`Install Dates: Recorded install date for /r/${subredditName}.`);
    await buildInstalledSubredditsReport(context);
}

async function buildInstalledSubredditsReport (context: TriggerContext) {
    const reportLastUpdatedKey = "installedSubredditsReportLastUpdated";
    if (await context.redis.exists(reportLastUpdatedKey)) {
        return;
    }

    const subsNotCheckedRecently = await context.redis.zRange(INSTALL_DATES_LAST_CHECKED_KEY, 0, subWeeks(new Date(), 1).getTime(), { by: "score" });

    if (subsNotCheckedRecently.length > 0) {
        await context.redis.zRem(INSTALL_DATES_KEY, subsNotCheckedRecently.map(sub => sub.member));
        await context.redis.zRem(INSTALL_DATES_LAST_CHECKED_KEY, subsNotCheckedRecently.map(sub => sub.member));
    }

    const installedSubs = await context.redis.zRange(INSTALL_DATES_KEY, Date.now(), subWeeks(new Date(), 1).getTime(), { by: "score", reverse: true });

    const report: json2md.DataObject[] = [
        { p: "This page shows the list of subreddits that have installed Bot Bouncer in the last week." },
        { p: "This report will be inaccurate until April 6 2026 due to the mechanism by which install dates are recorded." },
    ];

    const permissionIssues = await hMGetAsRecord(context.redis, PERMISSION_MESSAGE_SENT_HASH, installedSubs.map(sub => sub.member));

    const rows = installedSubs.map(sub => [
        sub.member,
        format(sub.score, "yyyy-MM-dd HH:mm"),
        permissionIssues[sub.member] ? "Yes" : "",
    ]);

    report.push({
        table: {
            headers: ["Subreddit", "Install Date", "Permission Issues Detected"],
            rows,
        },
    });

    report.push({ p: "This page updates once every 6 hours maximum." });

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/installed-subreddits",
        content: json2md(report),
    });

    console.log("Install Dates: Updated installed subreddits report.");

    await context.redis.set(reportLastUpdatedKey, "", { expiration: addHours(new Date(), 6) });
}
