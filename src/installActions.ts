import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CLEANUP_JOB, CLEANUP_JOB_CRON, CONTROL_SUBREDDIT, PROCESS_PENDING_QUEUE, UPDATE_DATASTORE_FROM_WIKI, UPDATE_WIKI_PAGE_JOB } from "./constants.js";
import { scheduleAdhocCleanup } from "./cleanup.js";
import { createExternalSubmissionJob } from "./externalSubmissions.js";

export async function handleInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("Detected an app install or update event!");

    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await context.scheduler.runJob({
            name: UPDATE_WIKI_PAGE_JOB,
            cron: "* * * * *",
        });

        await context.scheduler.runJob({
            name: PROCESS_PENDING_QUEUE,
            cron: "0/15 * * * *",
        });

        await createExternalSubmissionJob(context);

        console.log("Control subreddit jobs added");
    } else {
        await context.scheduler.runJob({
            name: UPDATE_DATASTORE_FROM_WIKI,
            cron: "0 * * * *",
        });

        await context.scheduler.runJob({
            name: UPDATE_DATASTORE_FROM_WIKI,
            runAt: new Date(),
        });

        console.log("Client subreddit jobs added");
    }

    await context.scheduler.runJob({
        name: CLEANUP_JOB,
        cron: CLEANUP_JOB_CRON,
    });

    await scheduleAdhocCleanup(context);
}
