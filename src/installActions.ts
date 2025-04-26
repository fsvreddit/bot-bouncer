import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CLEANUP_JOB_CRON, ClientSubredditJob, CONTROL_SUBREDDIT, ControlSubredditJob, POST_CREATION_JOB_CRON, UniversalJob } from "./constants.js";
import { scheduleAdhocCleanup } from "./cleanup.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { removeRetiredEvaluatorsFromStats } from "./userEvaluation/evaluatorHelpers.js";
import { schedulePostCreation } from "./postCreation.js";

export async function handleInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("App Install: Detected an app install or update event");

    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await addControlSubredditJobs(context);
    } else {
        await addClientSubredditJobs(context);
    }

    await context.scheduler.runJob({
        name: UniversalJob.Cleanup,
        cron: CLEANUP_JOB_CRON,
    });

    await scheduleAdhocCleanup(context);

    await checkJobsAreApplicable(context);

    // Delete cached control sub settings
    await context.redis.del("controlSubSettings");

    // Delete obsolete key
    await context.redis.del("activityCheckStore");
    await context.redis.del("activityCheckQueue");
}

async function addControlSubredditJobs (context: TriggerContext) {
    await Promise.all([
        context.scheduler.runJob({
            name: ControlSubredditJob.UpdateWikiPage,
            cron: "0/5 * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.UpdateStatisticsPage,
            cron: "0 0 * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.UpdateStatisticsPage,
            runAt: new Date(),
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
            cron: "5/30 * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.CopyControlSubSettings,
            cron: "15 * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.AsyncPostCreation,
            cron: POST_CREATION_JOB_CRON,
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.UptimeAndMessageCheck,
            cron: "2/20 * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.BioTextAnalyser,
            cron: "29 1/6 * * *",
        }),
    ]);

    await Promise.all([
        handleExternalSubmissionsPageUpdate(context),
        removeRetiredEvaluatorsFromStats(context),
        schedulePostCreation(context),
    ]);

    console.log("App Install: Control subreddit jobs added");
}

async function addClientSubredditJobs (context: TriggerContext) {
    let randomMinute = Math.floor(Math.random() * 5);
    await context.scheduler.runJob({
        name: ClientSubredditJob.UpdateDatastoreFromWiki,
        cron: `${randomMinute}/5 * * * *`,
    });

    await context.scheduler.runJob({
        name: ClientSubredditJob.UpdateDatastoreFromWiki,
        runAt: new Date(),
    });

    randomMinute = Math.floor(Math.random() * 60);
    let randomHour = Math.floor(Math.random() * 3);
    await context.scheduler.runJob({
        name: UniversalJob.UpdateEvaluatorVariables,
        cron: `${randomMinute} ${randomHour}/3 * * *`,
    });

    await context.scheduler.runJob({
        name: UniversalJob.UpdateEvaluatorVariables,
        runAt: new Date(),
    });

    randomMinute = Math.floor(Math.random() * 60);
    randomHour = Math.floor(Math.random() * 24);
    await context.scheduler.runJob({
        name: ClientSubredditJob.UpgradeNotifier,
        cron: `${randomMinute} ${randomHour} * * *`,
    });

    randomMinute = Math.floor(Math.random() * 60);
    await context.scheduler.runJob({
        name: ClientSubredditJob.SendDailyDigest,
        cron: `${randomMinute} 0 * * *`,
    });

    console.log("App Install: Client subreddit jobs added");
}

async function checkJobsAreApplicable (context: TriggerContext) {
    const allJobs = await context.scheduler.listJobs();
    const allowableJobs = Object.values(UniversalJob) as string[];
    if (context.subredditName === CONTROL_SUBREDDIT) {
        allowableJobs.push(...Object.values(ControlSubredditJob) as string[]);
    } else {
        allowableJobs.push(...Object.values(ClientSubredditJob) as string[]);
    }

    const badJobs = allJobs.filter(job => !allowableJobs.includes(job.name));
    if (badJobs.length === 0) {
        console.log("App Install: All jobs validated.");
        return;
    }

    for (const job of badJobs) {
        console.error(`App Install: Job ${job.name} is not applicable to this subreddit!`);
    }
}
