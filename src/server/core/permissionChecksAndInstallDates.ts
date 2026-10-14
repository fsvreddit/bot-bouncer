import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { CONTROL_SUBREDDIT } from "./constants";
import { addDays, addHours, addMinutes, addSeconds, addWeeks, format, subDays, subWeeks } from "date-fns";
import json2md from "json2md";
import { ControlSubredditJob, hasPermissions, hMGetAsRecord, isModerator } from ".";
import { getEvaluatorVariables } from "./userEvaluation";
import { CheckPermissionQueueItemJobData } from "../tasks";

const PERMISSION_CHECKS_QUEUE = "permissionChecksQueue";
const PERMISSION_MESSAGE_SENT_HASH = "permissionsMessageSent";
const INSTALL_DATES_KEY = "botBouncerInstallDates";
const INSTALL_DATES_LAST_CHECKED_KEY = "installDatesLastChecked";

export async function handlePermissionCheckEnqueue () {
    const subredditName = context.subredditName;
    if (subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Permission check enqueue job should not run on control subreddit");
    }

    await addSubToPermissionChecksQueue(subredditName);
}

async function addSubToPermissionChecksQueue (subredditName: string) {
    const recentCheckKey = `permissionCheckedRecentlyForSub:${subredditName}`;
    if (await redis.global.get(recentCheckKey)) {
        console.log(`Permission Checks: Recently checked /r/${subredditName}, skipping enqueue.`);
        return;
    }

    await redis.global.zAdd(PERMISSION_CHECKS_QUEUE, { member: subredditName, score: Date.now() });
    await redis.global.set(recentCheckKey, "true", { expiration: addDays(new Date(), 7) });
    console.log(`Permission Checks: Added /r/${subredditName} to permission checks queue.`);
}

function getPermissionMessageSentKeyForSubreddit (subredditName: string) {
    return `permissionMessageSent:${subredditName}`;
}

export async function checkPermissionQueueItems (event: TaskRequest<CheckPermissionQueueItemJobData>) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("checkPermissionQueueItems should only be called from control subreddit");
    }

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await redis.exists(`jobHandled:${jobGuid}`)) {
        console.warn(`Permission Checks: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const recentlyRunKey = "permissionChecksLastRunValue";
    if (event.data.firstRun && await redis.exists(recentlyRunKey)) {
        console.log("Permission Checks: Recently run, skipping this execution.");
        return;
    }

    const { subredditName, inBacklog } = await redis.global.zRange(PERMISSION_CHECKS_QUEUE, 0, 1)
        .then((items) => {
            if (items.length === 0) {
                return { subredditName: undefined, inBacklog: false };
            }

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            return { subredditName: items[0]!.member, inBacklog: items.length > 1 };
        });

    if (!subredditName) {
        return;
    }

    await redis.set(recentlyRunKey, "true", { expiration: addMinutes(new Date(), 1) });

    const problemFound: json2md.DataObject[] = [];
    let issueFound: string | undefined;

    let checkSucceeded = false;
    await redis.global.zRem(PERMISSION_CHECKS_QUEUE, [subredditName]);

    try {
        const isMod = await isModerator(subredditName, context.appSlug);

        if (!isMod) {
            problemFound.push([
                { p: `/u/bot-bouncer is not a moderator of /r/${subredditName}. This means Bot Bouncer cannot perform moderation checks or actions for this subreddit.` },
                { p: `Please check that you have the latest version of Bot Bouncer on your subreddit's [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/bot-bouncer), and then re-invite /u/bot-bouncer to the mod team with full permissions.` },
                { p: "If you no longer wish to use Bot Bouncer, it can be uninstalled from the same page." },
            ]);
            issueFound = "not a moderator";
        } else {
            const hasPerms = await hasPermissions({
                subredditName,
                username: context.appSlug,
                requiredPerms: ["access", "posts", "mail"],
            });

            if (!hasPerms) {
                problemFound.push([
                    { p: `/u/bot-bouncer is listed as a moderator of /r/${subredditName}, but it does not have all required moderator permissions.` },
                    { p: `When /u/bot-bouncer has no permissions, or is missing required permissions, Reddit may reject Bot Bouncer's requests with errors such as \`403 Forbidden\`.` },
                    { p: "This can prevent Bot Bouncer from checking ban status, reading required moderation information, handling modmail-related workflows, or applying moderation actions." },
                    { p: `Please check your subreddit's [app configuration page](https://developers.reddit.com/r/${subredditName}/apps/bot-bouncer), confirm that the latest version of Bot Bouncer is installed, and update /u/bot-bouncer to full moderator permissions.` },
                ]);
                issueFound = "missing permissions";
            }
        }
        checkSucceeded = true;
    } catch {
        console.log(`Permission Checks: Failed to check moderator status for /r/${subredditName}, assuming sub banned or platform issues.`);
        issueFound = "sub likely banned";
    }

    if (problemFound.length === 0) {
        if (checkSucceeded) {
            console.log(`Permission Checks: ${subredditName} passed permission checks.`);
        }

        await redis.hDel(PERMISSION_MESSAGE_SENT_HASH, [subredditName]);
        if (inBacklog) {
            await scheduler.runJob<CheckPermissionQueueItemJobData>({
                name: ControlSubredditJob.CheckPermissionQueueItems,
                runAt: addSeconds(new Date(), 2),
                data: { firstRun: false, jobGuid: crypto.randomUUID() },
            });
        }

        await recordInstallDate(subredditName);

        return;
    }

    if (await redis.exists(getPermissionMessageSentKeyForSubreddit(subredditName))) {
        console.log(`Permission Checks: Permissions message already sent to ${subredditName}, skipping check.`);
        if (inBacklog) {
            await scheduler.runJob<CheckPermissionQueueItemJobData>({
                name: ControlSubredditJob.CheckPermissionQueueItems,
                runAt: addSeconds(new Date(), 2),
                data: { firstRun: false, jobGuid: crypto.randomUUID() },
            });
        }
        return;
    }

    const messageSubject = "Bot Bouncer: Moderator Permissions Issue Detected";
    const message: json2md.DataObject[] = [
        { p: `Hello! During a recent check, Bot Bouncer detected that there is a problem with its moderator permissions in your subreddit, /r/${subredditName}. As a result, some or all of the bot's functionality may not work correctly.` },
        ...problemFound,
        { p: `If you have any questions or need assistance, please [message the mods of /r/BotBouncer](https://www.reddit.com/message/compose/?to=/r/BotBouncer).` },
        { p: `*This is an automated message, replies will not be read. You won't receive another notification about this issue for another four weeks unless the permissions change.*` },
    ];

    await reddit.sendPrivateMessage({
        to: `/r/${subredditName}`,
        subject: messageSubject,
        text: json2md(message),
    });

    await redis.hSet(PERMISSION_MESSAGE_SENT_HASH, { [subredditName]: issueFound ?? "unknown" });
    await redis.set(getPermissionMessageSentKeyForSubreddit(subredditName), Date.now().toString(), { expiration: addWeeks(new Date(), 4) });
    console.log(`Permission Checks: Sent permissions issue message to /r/${subredditName}.`);

    if (inBacklog) {
        await scheduler.runJob<CheckPermissionQueueItemJobData>({
            name: ControlSubredditJob.CheckPermissionQueueItems,
            runAt: addSeconds(new Date(), 30),
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
        });
    }

    await recordInstallDate(subredditName);
}

async function recordInstallDate (subredditName: string) {
    await redis.zAdd(INSTALL_DATES_LAST_CHECKED_KEY, { member: subredditName, score: Date.now() });
    const existingInstallDate = await redis.zScore(INSTALL_DATES_KEY, subredditName);
    if (existingInstallDate) {
        return;
    }

    await redis.zAdd(INSTALL_DATES_KEY, { member: subredditName, score: Date.now() });
    console.log(`Install Dates: Recorded install date for /r/${subredditName}.`);
    await buildInstalledSubredditsReport();
}

async function buildInstalledSubredditsReport () {
    const reportLastUpdatedKey = "installedSubredditsReportLastUpdate";
    if (await redis.exists(reportLastUpdatedKey)) {
        return;
    }

    await redis.set(reportLastUpdatedKey, "", { expiration: addHours(new Date(), 2) });

    // Checks are run weekly, so remove subs that are likely now uninstalled.
    const subsNotCheckedRecently = await redis.zRange(INSTALL_DATES_LAST_CHECKED_KEY, 0, subDays(new Date(), 29).getTime(), { by: "score" });

    if (subsNotCheckedRecently.length > 0) {
        await redis.zRem(INSTALL_DATES_KEY, subsNotCheckedRecently.map(sub => sub.member));
        await redis.zRem(INSTALL_DATES_LAST_CHECKED_KEY, subsNotCheckedRecently.map(sub => sub.member));
    }

    const startDateForReport = subWeeks(new Date(), 1);

    const installedSubs = await redis.zRange(INSTALL_DATES_KEY, startDateForReport.getTime(), Date.now(), { by: "score", reverse: true });
    // Sort by score (install date) descending
    installedSubs.sort((a, b) => b.score - a.score);

    const report: json2md.DataObject[] = [
        { p: "This page shows the list of subreddits that have installed Bot Bouncer in the last week." },
    ];

    const permissionIssues = await hMGetAsRecord(redis, PERMISSION_MESSAGE_SENT_HASH, installedSubs.map(sub => sub.member));
    const evaluatorVariables = await getEvaluatorVariables();

    const sweptSubs = new Set([
        ...evaluatorVariables["generic:karmafarminglinksubs"] as string[] | undefined ?? [],
        ...evaluatorVariables["generic:karmafarminglinksubsnsfw"] as string[] | undefined ?? [],
    ]);

    const rows = installedSubs.map(sub => [
        `r/${sub.member}`,
        format(sub.score, "yyyy-MM-dd HH:mm"),
        sweptSubs.has(sub.member) ? "Yes" : "",
        permissionIssues[sub.member] === "true" ? "yes, unknown reason" : permissionIssues[sub.member] ?? "",
    ]);

    report.push({
        table: {
            headers: ["Subreddit", "Install Date", "Swept by Bot Bouncer", "Permission Issues Detected"],
            rows,
        },
    });

    report.push({ p: "This page updates once every 6 hours maximum." });

    await reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/installed-subreddits",
        content: json2md(report),
    });

    console.log("Install Dates: Updated installed subreddits report.");
}
