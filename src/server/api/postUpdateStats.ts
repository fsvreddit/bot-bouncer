import { redis, scheduler } from "@devvit/web/server";
import { Context } from "hono";
import { ALL_POTENTIAL_USER_PREFIXES, ControlSubredditJob } from "../core";
import { addMinutes } from "date-fns";
import { SixHourlyJobData } from "../tasks";

export const handlePostUpdateStats = async (c: Context): Promise<Response> => {
    const runRecentlyKey = "UpdateStatsRunRecently";
    if (await redis.exists(runRecentlyKey)) {
        return c.json({ message: "Update stats job has run recently" }, 500);
    }

    await scheduler.runJob<SixHourlyJobData>({
        name: ControlSubredditJob.Perform6HourlyJobs,
        runAt: new Date(),
        data: {
            firstRun: true,
            jobGuid: crypto.randomUUID(),
            prefixes: ALL_POTENTIAL_USER_PREFIXES,
        },
    });

    await redis.set(runRecentlyKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    return c.json({ success: true }, 200);
};
