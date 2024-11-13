import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, UPDATE_DATASTORE_FROM_WIKI, UPDATE_WIKI_PAGE_JOB } from "./constants.js";

export async function handleInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await context.scheduler.runJob({
            name: UPDATE_WIKI_PAGE_JOB,
            cron: "* * * * *",
        });

        console.log("Control subreddit jobs added");
    } else {
        await context.scheduler.runJob({
            name: UPDATE_DATASTORE_FROM_WIKI,
            cron: "0 * * * *",
        });

        console.log("Client subreddit jobs added");
    }
}
