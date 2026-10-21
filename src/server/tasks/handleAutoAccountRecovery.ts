import type { Context } from "hono";
import { context, TaskRequest, TaskResponse } from "@devvit/web/server";
import { checkPotentiallyRecoveredAccounts, CONTROL_SUBREDDIT } from "../core";

export type RecoveredAccountsData = {
    firstRun: boolean;
    jobGuid: string;
};

export const handleAutoAccountRecoveryJob = async (c: Context): Promise<Response> => {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Auto Account Recovery: handleAutoAccountRecoveryJob should only be called in the control subreddit.");
    }

    const request = await c.req.json<TaskRequest<RecoveredAccountsData>>();

    await checkPotentiallyRecoveredAccounts(request);

    return c.json<TaskResponse>({ message: "Auto account recovery job handled" }, 200);
};
