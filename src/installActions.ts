import { AppInstall, AppUpgrade } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { CLEANUP_JOB, CLEANUP_JOB_CRON, CONTROL_SUBREDDIT, EVALUATE_KARMA_FARMING_SUBS, EXTERNAL_SUBMISSION_JOB, EXTERNAL_SUBMISSION_JOB_CRON, UPDATE_DATASTORE_FROM_WIKI, UPDATE_EVALUATOR_VARIABLES, UPDATE_STATISTICS_PAGE, UPDATE_WIKI_PAGE_JOB } from "./constants.js";
import { scheduleAdhocCleanup, setCleanupForSubmittersAndMods } from "./cleanup.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { compact, uniq } from "lodash";
import { UserDetails } from "./dataStore.js";

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
        name: CLEANUP_JOB,
        cron: CLEANUP_JOB_CRON,
    });

    await scheduleAdhocCleanup(context);
}

async function addControlSubredditJobs (context: TriggerContext) {
    await context.scheduler.runJob({
        name: UPDATE_WIKI_PAGE_JOB,
        cron: "0/5 * * * *",
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

    await context.scheduler.runJob({
        name: EVALUATE_KARMA_FARMING_SUBS,
        cron: "5/30 * * * *",
    });

    await context.scheduler.runJob({
        name: EXTERNAL_SUBMISSION_JOB,
        cron: EXTERNAL_SUBMISSION_JOB_CRON,
    });

    await handleReleaseUpgradeDataMigrationTasks(context);
    await handleExternalSubmissionsPageUpdate(context);

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
    const randomHour = Math.floor(Math.random() * 3);
    await context.scheduler.runJob({
        name: UPDATE_EVALUATOR_VARIABLES,
        cron: `${randomMinute} ${randomHour}/3 * * *`,
    });

    await context.scheduler.runJob({
        name: UPDATE_EVALUATOR_VARIABLES,
        runAt: new Date(),
    });

    console.log("App Install: Client subreddit jobs added");
}

async function handleReleaseUpgradeDataMigrationTasks (context: TriggerContext) {
    const redisKey = "ReleaseUpgradeMigrationSteps";
    const migrationStepsCompleted = (await context.redis.zRange(redisKey, 0, -1)).map(step => step.member);

    const migrationSteps = [
        "QueueCleanupForSubmittersAndMods",
    ];

    const pendingSteps = migrationSteps.filter(step => !migrationStepsCompleted.includes(step));

    for (const step of pendingSteps) {
        if (step === "QueueCleanupForSubmittersAndMods") {
            const data = await context.redis.hGetAll("UserStore");
            const values = Object.values(data).map(value => JSON.parse(value) as UserDetails);
            const users = uniq(compact([...values.map(item => item.operator), ...values.map(item => item.submitter)]));
            await setCleanupForSubmittersAndMods(users, context);
            console.log(`Release Upgrade: Queued cleanup for ${users.length} submitters and mods`);
        }

        await context.redis.zAdd(redisKey, { member: step, score: new Date().getTime() });
    }
}
