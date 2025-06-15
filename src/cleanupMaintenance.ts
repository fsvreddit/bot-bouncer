import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getAllKnownUsers } from "./dataStore.js";
import { addDays, addMinutes, addSeconds, subDays } from "date-fns";
import { setCleanupForUser, userHasCleanupEntry } from "./cleanup.js";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";

export async function performCleanupMaintenance (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.log("Cleanup Maintenance: Skipping as this is not the control subreddit.");
        return;
    }

    const storeKey = "CleanupMaintenanceStore";
    const cleanupMaintenanceRunKey = "CleanupMaintenanceRun";

    if (event.data?.firstRun) {
        const lastRun = await context.redis.get(cleanupMaintenanceRunKey);
        if (lastRun && new Date(parseInt(lastRun)) > subDays(new Date(), 14)) {
            console.log("Cleanup Maintenance: Skipping first run as it was recently run.");
            return;
        }

        const allUsers = await getAllKnownUsers(context);
        await context.redis.zAdd(storeKey, ...allUsers.map(user => ({ member: user, score: 0 })));
        await context.scheduler.runJob({
            name: ControlSubredditJob.PerformCleanupMaintenance,
            runAt: addSeconds(new Date(), 5),
            data: { firstRun: false },
        });
        return;
    }

    await context.redis.set(cleanupMaintenanceRunKey, Date.now().toString(), { expiration: addDays(new Date(), 14) });

    const runLimit = addSeconds(new Date(), 20);
    const handledUsers: string[] = [];
    const queued = await context.redis.zRange(storeKey, 0, 200);

    if (queued.length === 0) {
        console.log("Cleanup Maintenance: No users to process.");
        await context.redis.del(storeKey);
        return;
    }

    let added = 0;

    while (queued.length > 0 && new Date() < runLimit) {
        const user = queued.shift()?.member;
        if (!user) {
            break;
        }

        if (!await userHasCleanupEntry(user, context)) {
            const cleanupTime = addSeconds(addMinutes(new Date(), 5), Math.floor(Math.random() * 60 * 60));
            await setCleanupForUser(user, context.redis, cleanupTime);
            console.log(`Cleanup Maintenance: User ${user} has no cleanup entry.`);
            added++;
        }

        handledUsers.push(user);
    }

    if (handledUsers.length > 0) {
        await context.redis.zRem(storeKey, handledUsers);
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.PerformCleanupMaintenance,
        runAt: addSeconds(new Date(), 2),
        data: { firstRun: false },
    });

    console.log(`Cleanup Maintenance: Processed ${handledUsers.length} users, added ${added} to cleanup.`);
}
