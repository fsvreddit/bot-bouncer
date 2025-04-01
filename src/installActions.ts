import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CLEANUP_JOB, CLEANUP_JOB_CRON, CONTROL_SUBREDDIT, EVALUATE_KARMA_FARMING_SUBS, EXTERNAL_SUBMISSION_JOB, EXTERNAL_SUBMISSION_JOB_CRON, SEND_DAILY_DIGEST, UPDATE_DATASTORE_FROM_WIKI, UPDATE_EVALUATOR_VARIABLES, UPDATE_STATISTICS_PAGE, UPDATE_WIKI_PAGE_JOB, UPGRADE_NOTIFIER_JOB } from "./constants.js";
import { scheduleAdhocCleanup } from "./cleanup.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { removeRetiredEvaluatorsFromStats } from "./userEvaluation/evaluatorHelpers.js";

export async function handleInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("App Install: Detected an app install or update event");

    const currentJobs = await context.scheduler.listJobs();
    console.log(currentJobs);
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

    // Delete cached control sub settings
    await context.redis.del("controlSubSettings");
}

async function addControlSubredditJobs (context: TriggerContext) {
    await context.scheduler.runJob({
        name: UPDATE_WIKI_PAGE_JOB,
        cron: "0/5 * * * *",
    });

    await context.scheduler.runJob({
        name: UPDATE_STATISTICS_PAGE,
        cron: "0 0 * * *",
    });

    await context.scheduler.runJob({
        name: UPDATE_STATISTICS_PAGE,
        runAt: new Date(),
    });

    await context.scheduler.runJob({
        name: EVALUATE_KARMA_FARMING_SUBS,
        cron: "5/30 * * * *",
    });

    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        cron: EXTERNAL_SUBMISSION_JOB_CRON,
    });

    await handleExternalSubmissionsPageUpdate(context);
    await removeRetiredEvaluatorsFromStats(context);

    console.log("App Install: Control subreddit jobs added");
}

async function addClientSubredditJobs (context: TriggerContext) {
    let randomMinute = Math.floor(Math.random() * 5);
    await context.scheduler.runJob({
        name: UPDATE_DATASTORE_FROM_WIKI,
        cron: `${randomMinute}/5 * * * *`,
    });

    await context.scheduler.runJob({
        name: UPDATE_DATASTORE_FROM_WIKI,
        runAt: new Date(),
    });

    randomMinute = Math.floor(Math.random() * 60);
    let randomHour = Math.floor(Math.random() * 3);
    await context.scheduler.runJob({
        name: UPDATE_EVALUATOR_VARIABLES,
        cron: `${randomMinute} ${randomHour}/3 * * *`,
    });

    await context.scheduler.runJob({
        name: UPDATE_EVALUATOR_VARIABLES,
        runAt: new Date(),
    });

    randomMinute = Math.floor(Math.random() * 60);
    randomHour = Math.floor(Math.random() * 24);
    await context.scheduler.runJob({
        name: UPGRADE_NOTIFIER_JOB,
        cron: `${randomMinute} ${randomHour} * * *`,
    });

    randomMinute = Math.floor(Math.random() * 60);
    await context.scheduler.runJob({
        name: SEND_DAILY_DIGEST,
        cron: `${randomMinute} 0 * * *`,
    });

    console.log("App Install: Client subreddit jobs added");
}
