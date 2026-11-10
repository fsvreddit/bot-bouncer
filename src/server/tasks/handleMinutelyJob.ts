import { context, scheduler, TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { areAnyDelayedMessagesQueued } from "../core/controlSubCore/modmail";
import { DelayedMessageJobData } from ".";
import { checkBotPostFreshness, CONTROL_SUBREDDIT, ControlSubredditJob, processFeedbackQueue } from "../core";
import { handleClassificationQueryQueue } from "../core/controlSubCore/modmail/classificationQuery";
import { resumeStuckExtracts } from "../core/controlSubCore/modmail/dataExtract";
import { resumeSocialLinksJob, resumeStuckDefinedHandlesJob } from "../core/controlSubCore/statistics";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addSeconds } from "date-fns";

export const handleMinutelyJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Minutely jobs are only run in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest>();
    if (await hasEventBeenHandled(`job:${request.name}`, { expiration: addSeconds(new Date(), 10) })) {
        return c.json<TaskResponse>({ message: "Event has already been handled." }, 200);
    }

    if (await areAnyDelayedMessagesQueued()) {
        await scheduler.runJob<DelayedMessageJobData>({
            name: ControlSubredditJob.ProcessDelayedMessages,
            data: { firstRun: true, jobGuid: crypto.randomUUID() },
            runAt: new Date(),
        });
    }

    await Promise.allSettled([
        processFeedbackQueue(),
        handleClassificationQueryQueue(),
        checkBotPostFreshness(),
        resumeStuckExtracts(),
        resumeStuckDefinedHandlesJob(),
        resumeSocialLinksJob(),
    ]);

    return c.json<TaskResponse>({ success: true }, 200);
};
