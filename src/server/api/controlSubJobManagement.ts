import { context, scheduler } from "@devvit/web/server";
import { Context } from "hono";
import { addControlSubredditJobs, CONTROL_SUBREDDIT, ControlSubredditJob, UniversalJob } from "../core";

/**
 * Handles POST requests to control subreddit jobs.
 * Supports actions: "cancel" and "resume" within the query string.
 *
 * Wondering why this exists? It's to allow me to disable all cron jobs on r/BotBouncer
 * before the upcoming migrations on December 3, then enable them again. I will
 * trigger this via a POST request from ThunderClient.
 *
 * The app is probably going to go crazy pinging our Discord server if the jobs are running as well as causing
 * a waste of resource.
 */
export const handlePostControlSubJobs = async (c: Context): Promise<Response> => {
    const action = c.req.query("action");
    if (!action) {
        return new Response("Action query parameter is missing", { status: 400 });
    }

    const allowableActions = ["cancel", "resume"];

    if (!allowableActions.includes(action)) {
        return new Response(`Invalid action ${action}`, { status: 400 });
    }

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return new Response(`Cannot ${action} jobs for r/${context.subredditName}`, { status: 400 });
    }

    const relevantJobs: string[] = [...Object.values(ControlSubredditJob), ...Object.values(UniversalJob)];
    const jobsToCancel = await scheduler.listJobs().then(jobs => jobs.filter(job => "cron" in job || !relevantJobs.includes(job.name)));

    await Promise.all(jobsToCancel.map(job => scheduler.cancelJob(job.id)));

    console.log(`Cancelled ${jobsToCancel.length} jobs`);

    if (action === "resume") {
        await addControlSubredditJobs();
        return new Response(`Resumed control subreddit jobs`, { status: 200 });
    }

    return new Response(`Cancelled ${jobsToCancel.length} jobs`, { status: 200 });
};
