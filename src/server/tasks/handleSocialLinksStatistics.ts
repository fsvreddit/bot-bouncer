import type { Context } from "hono";
import { context, redis, TaskRequest, TaskResponse } from "@devvit/web/server";
import { addMinutes } from "date-fns";
import { CONTROL_SUBREDDIT } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { handleSocialLinksStatisticsFinalise, handleSocialLinksStatisticsInitialise, handleSocialLinksStatisticsProcess } from "../core/controlSubCore/statistics";

export type SocialLinksStatisticsJobData = {
    jobGuid: string;
    phase: "initialise" | "process" | "finalise";
    prefixes?: string[];
};

export const handleSocialLinksStatisticsJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Social Links Statistics: handleSocialLinksStatisticsJob should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<SocialLinksStatisticsJobData | undefined>>();

    const stuckJobDataKey = "SocialLinksStuckJobData";
    if (!request.data) {
        const stuckJobData = await redis.get(stuckJobDataKey);
        if (stuckJobData) {
            request.data = JSON.parse(stuckJobData) as SocialLinksStatisticsJobData;
            request.data.jobGuid = crypto.randomUUID();
        } else {
            throw new Error("No job data available for stuck Social Links Statistics job.");
        }
    }

    await redis.set(stuckJobDataKey, JSON.stringify(request.data), { expiration: addMinutes(new Date(), 30) });

    if (await hasEventBeenHandled(`job:${request.data.jobGuid}`)) {
        return c.json<TaskResponse>({ message: "Job already handled" }, 200);
    }

    if (request.data.phase === "initialise") {
        await handleSocialLinksStatisticsInitialise(request.data);
    } else if (request.data.phase === "process") {
        await handleSocialLinksStatisticsProcess();
    } else {
        await handleSocialLinksStatisticsFinalise();
    }

    return c.json<TaskResponse>({ message: "Social Links Statistics handled" }, 200);
};
