import { redis, scheduler } from "@devvit/web/server";
import { Context } from "hono";
import { ControlSubredditJob } from "../core";
import { addMinutes } from "date-fns";

export const handlePostUpdateStats = async (c: Context): Promise<Response> => {
    const runRecentlyKey = "UpdateStatsRunRecently";
    if (await redis.exists(runRecentlyKey)) {
        return c.json({ message: "Update stats job has run recently" }, 500);
    }
    await scheduler.runJob({
        name: ControlSubredditJob.Perform6HourlyJobs,
        runAt: new Date(),
    });

    await redis.set(runRecentlyKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    return c.json({ success: true }, 200);
};
