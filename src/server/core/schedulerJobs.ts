import { context, redis, scheduler } from "@devvit/web/server";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { getControlSubSettings } from "./controlSubSettings";
import { CONTROL_SUBREDDIT } from "./constants";
import { UpgradeNotifierData } from "@fsvreddit/fsv-devvit-web-helpers";
import { AppSetting } from "./appSettings";
import { ClientSubredditJob, ControlSubredditJob, handleExternalSubmissionsPageUpdate, ObserverSubredditJob, UniversalJob } from ".";
import { EvaluateKarmaFarmingSubsEventData, UpdateEvaluatorVariablesFromWikiEventData } from "../tasks";
import { forceEvaluatorVariablesRefresh } from "./userEvaluation";

export { UniversalJob, ControlSubredditJob, ClientSubredditJob, ObserverSubredditJob } from "./schedulerJobNames.js";

export async function addControlSubredditJobs () {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Not the control subreddit");
    }

    await Promise.all([
        scheduler.runJob({
            name: ControlSubredditJob.Perform6HourlyJobs,
            cron: "0 0/6 * * *",
        }),

        scheduler.runJob({
            name: ControlSubredditJob.QueueKarmaFarmingSubs,
            cron: "5/10 * * * *",
        }),

        scheduler.runJob<EvaluateKarmaFarmingSubsEventData>({
            name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
            cron: "* * * * *",
            data: { firstRun: true },
        }),

        scheduler.runJob({
            name: ControlSubredditJob.RapidJob,
            cron: "*/10 * * * * *",
        }),

        scheduler.runJob({
            name: ControlSubredditJob.UptimeAndMessageCheck,
            cron: "2/20 * * * *",
        }),

        scheduler.runJob({
            name: ControlSubredditJob.Perform5MinutelyJobs,
            cron: "*/5 * * * *",
        }),

        scheduler.runJob({
            name: ControlSubredditJob.PerformMinutelyJobs,
            cron: "* * * * *",
        }),

        scheduler.runJob<UpdateEvaluatorVariablesFromWikiEventData>({
            name: ControlSubredditJob.UpdateEvaluatorVariables,
            cron: "0/10 * * * *",
            data: {
                username: context.appSlug,
                updateExtraVariables: true,
            },
        }),

        scheduler.runJob({
            name: ControlSubredditJob.PendingUserFinder,
            runAt: addSeconds(new Date(), 10),
        }),

        scheduler.runJob({
            name: UniversalJob.Cleanup,
            cron: "* * * * *",
            data: { firstRun: true },
        }),
    ]);

    await Promise.all([
        handleExternalSubmissionsPageUpdate(),
    ]);

    console.log("App Install: Control subreddit jobs added");
}

export async function addClientSubredditJobs () {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Not a client subreddit");
    }

    const controlSubSettings = await getControlSubSettings();
    if (controlSubSettings.observerSubreddits?.includes(context.subredditName)) {
        await scheduler.runJob({
            name: ObserverSubredditJob.HandleObserverSubMinutelyJob,
            cron: "* * * * *",
        });

        return;
    }

    await scheduler.runJob({
        name: ClientSubredditJob.QueueReclassificationChanges,
        cron: "* * * * *",
    });

    await scheduler.runJob({
        name: ClientSubredditJob.RemoveUsersFromModqueueAfterBan,
        cron: "* * * * *",
    });

    let randomMinute = Math.floor(Math.random() * 60);
    let randomHour = Math.floor(Math.random() * 24);
    await scheduler.runJob<UpgradeNotifierData>({
        name: ClientSubredditJob.UpgradeNotifier,
        cron: `${randomMinute} ${randomHour} * * *`,
        data: {
            appFriendlyName: "Bot Bouncer",
            settingName: AppSetting.UpgradeNotifier,
        },
    });

    randomMinute = Math.floor(Math.random() * 60);
    await scheduler.runJob({
        name: ClientSubredditJob.SendDailyDigest,
        cron: `${randomMinute} 0 * * *`,
    });

    randomMinute = Math.floor(Math.random() * 60);
    await scheduler.runJob({
        name: UniversalJob.Cleanup,
        cron: `${randomMinute} 0/2 * * *`, // Every two hours
        data: { firstRun: true },
    });

    randomMinute = Math.floor(Math.random() * 60);
    randomHour = Math.floor(Math.random() * 24);
    await scheduler.runJob({
        name: ClientSubredditJob.PermissionCheckEnqueue,
        cron: `${randomMinute} ${randomHour} * * *`,
    });

    await scheduler.runJob({
        name: ClientSubredditJob.PermissionCheckEnqueue,
        runAt: addMinutes(new Date(), 5),
    });

    randomMinute = Math.floor(Math.random() * 60);
    randomHour = Math.floor(Math.random() * 24);
    await scheduler.runJob({
        name: ClientSubredditJob.ClientSubAnnouncements,
        cron: `${randomMinute} ${randomHour} * * *`,
    });

    console.log("App Install: Client subreddit jobs added");

    await forceEvaluatorVariablesRefresh();
}

export async function checkJobsAreApplicable () {
    const allJobs = await scheduler.listJobs();
    const allowableJobs = Object.values(UniversalJob) as string[];
    if (context.subredditName === CONTROL_SUBREDDIT) {
        allowableJobs.push(...Object.values(ControlSubredditJob) as string[]);
    } else {
        allowableJobs.push(...Object.values(ClientSubredditJob) as string[]);
        allowableJobs.push(...Object.values(ObserverSubredditJob) as string[]);
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

export async function ensureClientSubJobsExist () {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("ensureClientSubJobsExist should not be called from control subreddit");
    }

    const lastCheckKey = "clientJobCheckerLastCheckValue";
    if (await redis.exists(lastCheckKey)) {
        return;
    }

    await redis.set(lastCheckKey, "true", { expiration: addDays(new Date(), 1) });

    const expectedJobs: string[] = [
        ClientSubredditJob.QueueReclassificationChanges,
        ClientSubredditJob.UpgradeNotifier,
        ClientSubredditJob.SendDailyDigest,
        ClientSubredditJob.PermissionCheckEnqueue,
        ClientSubredditJob.ClientSubAnnouncements,
        ClientSubredditJob.RemoveUsersFromModqueueAfterBan,
        UniversalJob.Cleanup,
    ];

    const allJobs = await scheduler.listJobs();
    const activeCronJobs = allJobs.filter(job => "cron" in job);
    const missingJobs = expectedJobs.filter(expectedJob => !activeCronJobs.some(currentJob => currentJob.name === expectedJob));

    if (missingJobs.length > 0) {
        console.error(`Missing jobs detected - ${missingJobs.join(", ")}`);
        await Promise.all(activeCronJobs.map(job => scheduler.cancelJob(job.id)));
        await addClientSubredditJobs();
    } else {
        console.log("All client subreddit jobs are present.");
    }
}
