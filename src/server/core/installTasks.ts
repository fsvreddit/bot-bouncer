import { context, reddit, redis, scheduler } from "@devvit/web/server";
import { hasEventBeenHandled, isModerator } from "@fsvreddit/fsv-devvit-web-helpers";
import { addSeconds, isSameDay } from "date-fns";
import { APP_ACCOUNT_ID, CONTROL_SUBREDDIT } from "./constants";
import { addClientSubredditJobs, addControlSubredditJobs, checkJobsAreApplicable } from "./schedulerJobs";
import json2md from "json2md";
import { storeRecordOfContentCreationGracePeriod } from "./clientSubCore";

export async function handleInstallTasks () {
    if (await hasEventBeenHandled("installOrUpgrade", { expiration: addSeconds(new Date(), 10) })) {
        return;
    }

    const currentJobs = await scheduler.listJobs();
    await Promise.all(currentJobs.map(job => scheduler.cancelJob(job.id)));
    console.log(`App Install: Cancelled ${currentJobs.length} existing jobs.`);

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await addControlSubredditJobs();
        const appAccount = await reddit.getAppUser();
        if (appAccount?.id !== APP_ACCOUNT_ID) {
            console.warn(`App Install: The app account ID is ${appAccount?.id}, expected ${APP_ACCOUNT_ID}.`);
        }
    } else {
        // Delete cached control sub settings
        await redis.del("controlSubSettings", "evaluatorVariablesHash");
        await addClientSubredditJobs();

        // Keep this indefinitely, or until everyone has been forced onto a new version for at least a week.
        await storeRecordOfContentCreationGracePeriod();
    }

    await checkJobsAreApplicable();

    // Remove legacy redis keys
    const obsoleteKeys = [
        "evaluatorVariables",
        "clientSubWikiUpdateCron",
        "oneOffReaffirmation",
        "EvaluatorStats",
        "UserStore",
        "oneOffDataMigrationDone",
        "BioTextQueue",
        "BioTextStatsTempStore",
        "BioTextStatsCounts",
        "installedSubredditsReportLastUpdated",
        "modmailSummaryPrompt",
        "aiPromptCache",
        "classificationChangesLastRun",
        "AppPermissionsCache",
        "permissionChecksLastRun",
        "installedSubredditsReportLastUpdated",
        "definedHandlesStatsLastRun",
        "BioTextAnalysisRecentlyRun",
    ];

    await redis.del(...obsoleteKeys);

    await setInstallDateIfNotSet();
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        await checkForBotSwatter();
    }

    console.log(`App Install: Install or upgrade actions complete for ${context.appSlug}, now running version ${context.appVersion}`);
}

async function setInstallDateIfNotSet () {
    const installDateKey = "appInstallDate";
    if (await redis.exists(installDateKey)) {
        return;
    }

    await redis.set(installDateKey, Date.now().toString());
}

export async function getInstallDate (): Promise<Date | undefined> {
    const installDateKey = "appInstallDate";
    const installDateString = await redis.get(installDateKey);
    if (!installDateString) {
        return undefined;
    }
    const installDateMillis = parseInt(installDateString, 10);
    if (isNaN(installDateMillis)) {
        return undefined;
    }
    return new Date(installDateMillis);
}

async function checkForBotSwatter () {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("checkForBotSwatter must not be called in the control subreddit");
    }

    const botSwatterCheckDoneKey = "botSwatterCheckDone";
    if (await redis.exists(botSwatterCheckDoneKey)) {
        return;
    }

    const installDate = await getInstallDate();
    if (!installDate) {
        // Should be impossible.
        return;
    }

    if (!await isModerator(context.subredditName, "bot-swatter")) {
        await redis.set(botSwatterCheckDoneKey, "true");
        return;
    }

    const actionVerbage = isSameDay(installDate, new Date()) ? "installing" : "upgrading";

    const message: json2md.DataObject[] = [
        { p: `Hi, thanks for ${actionVerbage} Bot Bouncer.` },
        { p: `It looks like you have my earlier app, LLM Bot Swatter, installed in this subreddit. Bot Swatter is now deprecated, and is unlikely to catch genuine bots any longer. It may also have false positives.` },
        { p: `We recommend that you uninstall Bot Swatter. If you wish to do so, please see its settings page here: https://developers.reddit.com/r/${context.subredditName}/apps/bot-swatter` },
        { p: `If you have any questions, please reach out to the mods of Bot Bouncer by modmail.` },
    ];

    await reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: `Thanks for ${actionVerbage} Bot Bouncer - Bot Swatter detected`,
        bodyMarkdown: json2md(message),
    });

    await redis.set(botSwatterCheckDoneKey, "true");
}
