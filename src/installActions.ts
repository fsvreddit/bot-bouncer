import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { ClientSubredditJob, CONTROL_SUBREDDIT, ControlSubredditJob, UniversalJob } from "./constants.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { removeRetiredEvaluatorsFromStats } from "./userEvaluation/evaluatorHelpers.js";
import { getControlSubSettings } from "./settings.js";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { migrationToGlobalRedis } from "./dataStore.js";
import { forceEvaluatorVariablesRefresh } from "./userEvaluation/evaluatorVariables.js";

export async function handleInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    console.log("App Install: Detected an app install or update event");

    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));
    console.log(`App Install: Cancelled ${currentJobs.length} existing jobs.`);

    await migrationToGlobalRedis(context);

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await addControlSubredditJobs(context);
    } else {
        // Delete cached control sub settings
        await context.redis.del("controlSubSettings");
        await addClientSubredditJobs(context);
    }

    await checkJobsAreApplicable(context);

    // Remove legacy redis keys
    await context.redis.del("evaluatorVariables");
    await context.redis.del("clientSubWikiUpdateCron");
    await context.redis.del("ReclassificationQueue");
    await context.redis.del("oneOffReaffirmation");
}

async function addControlSubredditJobs (context: TriggerContext) {
    await Promise.all([
        context.scheduler.runJob({
            name: ControlSubredditJob.UpdateWikiPage,
            cron: "* * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.Perform6HourlyJobs,
            cron: "0 0/6 * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.QueueKarmaFarmingSubs,
            cron: "5/10 * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
            cron: "* * * * *",
            data: { firstRun: true },
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.RapidJob,
            cron: "*/20 * * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.UptimeAndMessageCheck,
            cron: "2/20 * * * *",
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.CheckPermissionQueueItems,
            cron: "*/5 * * * *",
        }),

        context.scheduler.runJob({
            name: UniversalJob.Cleanup,
            cron: "* * * * *",
            data: { firstRun: true },
        }),

        context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReversals,
            runAt: addSeconds(new Date(), 5),
            data: { firstRun: true },
        }),
    ]);

    await Promise.all([
        handleExternalSubmissionsPageUpdate(context),
        removeRetiredEvaluatorsFromStats(context),
    ]);

    console.log("App Install: Control subreddit jobs added");
}

async function addClientSubredditJobs (context: TriggerContext) {
    const controlSubSettings = await getControlSubSettings(context);
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    if (controlSubSettings.observerSubreddits?.includes(subredditName)) {
        console.log(`App Install: ${subredditName} is an observer subreddit, skipping job creation.`);
        return;
    }

    await context.scheduler.runJob({
        name: ClientSubredditJob.QueueReclassificationChanges,
        cron: "* * * * *",
    });

    let randomMinute = Math.floor(Math.random() * 60);
    let randomHour = Math.floor(Math.random() * 24);
    await context.scheduler.runJob({
        name: ClientSubredditJob.UpgradeNotifier,
        cron: `${randomMinute} ${randomHour} * * *`,
    });

    randomMinute = Math.floor(Math.random() * 60);
    await context.scheduler.runJob({
        name: ClientSubredditJob.SendDailyDigest,
        cron: `${randomMinute} 0 * * *`,
    });

    randomMinute = Math.floor(Math.random() * 60);
    await context.scheduler.runJob({
        name: UniversalJob.Cleanup,
        cron: `${randomMinute} 0/2 * * *`, // Every two hours
        data: { firstRun: true },
    });

    randomMinute = Math.floor(Math.random() * 60);
    randomHour = Math.floor(Math.random() * 24);
    await context.scheduler.runJob({
        name: ClientSubredditJob.PermissionCheckEnqueue,
        cron: `${randomMinute} ${randomHour} * * *`,
    });

    await context.scheduler.runJob({
        name: ClientSubredditJob.PermissionCheckEnqueue,
        runAt: addMinutes(new Date(), 5),
    });

    console.log("App Install: Client subreddit jobs added");

    await forceEvaluatorVariablesRefresh(context);
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
        console.log(`App Install: All ${allJobs.length} jobs validated.`);
        return;
    }

    for (const job of badJobs) {
        console.error(`App Install: Job ${job.name} is not applicable to this subreddit!`);
    }

    if (!allJobs.some(job => job.name === UniversalJob.Cleanup as string)) {
        console.error("App Install: Cleanup job is not configured on this subreddit!");
    }
}

export async function ensureClientSubJobsExist (context: TriggerContext) {
    const lastCheckKey = "clientJobCheckerLastCheck";
    if (await context.redis.exists(lastCheckKey)) {
        return;
    }

    await context.redis.set(lastCheckKey, "true", { expiration: addDays(new Date(), 1) });

    const expectedJobs: string[] = [
        ClientSubredditJob.QueueReclassificationChanges,
        ClientSubredditJob.UpgradeNotifier,
        ClientSubredditJob.SendDailyDigest,
        UniversalJob.Cleanup,
    ];

    const allJobs = await context.scheduler.listJobs();
    const activeCronJobs = allJobs.filter(job => "cron" in job);
    const missingJobs = expectedJobs.filter(expectedJob => !activeCronJobs.some(currentJob => currentJob.name === expectedJob));

    if (missingJobs.length > 0) {
        console.error(`Missing jobs detected - ${missingJobs.join(", ")}`);
        await Promise.all(activeCronJobs.map(job => context.scheduler.cancelJob(job.id)));
        await addClientSubredditJobs(context);
    } else {
        console.log("All client subreddit jobs are present.");
    }
}
