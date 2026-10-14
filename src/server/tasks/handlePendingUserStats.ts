import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { createSummariesForPendingUsers, pendingUserFinder } from "../core/controlSubCore/statistics";

export type PendingUserFinderJobData = {
    jobGuid: string;
};

export const handlePendingUserFinderJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<PendingUserFinderJobData>>();

    await pendingUserFinder(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};

export type CreateSummariesForPendingUsersJobData = {
    jobGuid: string;
    userData: {
        username: string;
        postId: string;
    }[];
};

export const handleCreateSummariesForPendingUsersJob = async (c: Context): Promise<Response> => {
    const jobRequest = await c.req.json<TaskRequest<CreateSummariesForPendingUsersJobData>>();

    await createSummariesForPendingUsers(jobRequest);

    return c.json<TaskResponse>({ success: true }, 200);
};
