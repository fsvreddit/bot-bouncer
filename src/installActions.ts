import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CLEANUP_JOB, CLEANUP_JOB_CRON, CONTROL_SUBREDDIT, UPDATE_DATASTORE_FROM_WIKI, UPDATE_STATISTICS_PAGE, UPDATE_WIKI_PAGE_JOB } from "./constants.js";
import { scheduleAdhocCleanup } from "./cleanup.js";
import { createExternalSubmissionJob } from "./externalSubmissions.js";

export async function handleInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("Detected an app install or update event");

    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await addControlSubredditJobs(context);
    } else {
        await addClientSubredditJobs(context);
    }

    await context.scheduler.runJob({
        name: CLEANUP_JOB,
        cron: CLEANUP_JOB_CRON,
    });

    await scheduleAdhocCleanup(context);
}

async function addControlSubredditJobs (context: TriggerContext) {
    await context.scheduler.runJob({
        name: UPDATE_WIKI_PAGE_JOB,
        cron: "0/15 * * * *",
    });

    await context.scheduler.runJob({
        name: UPDATE_WIKI_PAGE_JOB,
        cron: "5 5 1 * *",
        data: { force: true },
    });

    await context.scheduler.runJob({
        name: UPDATE_STATISTICS_PAGE,
        cron: "0 0 * * *",
    });

    await context.scheduler.runJob({
        name: UPDATE_STATISTICS_PAGE,
        runAt: new Date(),
    });

    await createExternalSubmissionJob(context);

    console.log("Control subreddit jobs added");
}

async function addClientSubredditJobs (context: TriggerContext) {
    const randomMinute = Math.floor(Math.random() * 15);
    await context.scheduler.runJob({
        name: UPDATE_DATASTORE_FROM_WIKI,
        cron: `${randomMinute}/15 * * * *`,
    });

    await context.scheduler.runJob({
        name: UPDATE_DATASTORE_FROM_WIKI,
        runAt: new Date(),
    });

    console.log("Client subreddit jobs added");
}
