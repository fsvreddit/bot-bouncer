import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
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

    const request = await c.req.json<TaskRequest<SocialLinksStatisticsJobData>>();

    if (await hasEventBeenHandled(`job:${request.data.jobGuid}`)) {
        return c.json<TaskResponse>({ message: "Job already handled" }, 200);
    }

    if (request.data.phase === "initialise") {
        await handleSocialLinksStatisticsInitialise(request);
    } else if (request.data.phase === "process") {
        await handleSocialLinksStatisticsProcess();
    } else {
        await handleSocialLinksStatisticsFinalise();
    }

    return c.json<TaskResponse>({ message: "Social Links Statistics handled" }, 200);
};
