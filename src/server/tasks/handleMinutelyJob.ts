import { context, scheduler, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { areAnyDelayedMessagesQueued } from "../core/controlSubCore/modmail";
import { DelayedMessageJobData } from ".";
import { checkBotPostFreshness, CONTROL_SUBREDDIT, ControlSubredditJob, processFeedbackQueue } from "../core";
import { handleClassificationQueryQueue } from "../core/controlSubCore/modmail/classificationQuery";
import { resumeStuckExtracts } from "../core/controlSubCore/modmail/dataExtract";
import { resumeStuckDefinedHandlesJob } from "../core/controlSubCore/statistics";

export const handleMinutelyJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Minutely jobs are only run in the control subreddit.");
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
    ]);

    return c.json<TaskResponse>({ success: true }, 200);
};
