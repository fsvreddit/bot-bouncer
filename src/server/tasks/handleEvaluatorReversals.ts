import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { classificationReversalsJob, deleteRecordsForRemovedUsers, reversePostCreationQueue } from "../core/controlSubCore/modmail";

export type ClassificationReversalsJobData = {
    firstRun: boolean;
    usersToReverse?: string[];
    reversedTotal?: number;
    conversationId: string;
    jobGuid: string;
};

export const handleClassificationReversalsJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<ClassificationReversalsJobData>>();

    await classificationReversalsJob(request);
    return c.json<TaskResponse>({ success: true }, 200);
};

export type ReversePostCreationQueueData = {
    firstRun: boolean;
    conversationId: string;
    queueUsers?: string[];
    submitter?: string;
    hitReason?: string;
    hitReasonRegex?: string;
    reversedTotal?: number;
    jobGuid: string;
};

export const handleReversePostCreationQueueJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<ReversePostCreationQueueData>>();

    await reversePostCreationQueue(request);
    return c.json<TaskResponse>({ success: true }, 200);
};

export type DeleteRecordsForRemovedUsersData = {
    jobGuid: string;
};

export const handleDeleteRecordsForRemovedUsersJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest<DeleteRecordsForRemovedUsersData>>();

    await deleteRecordsForRemovedUsers(request);
    return c.json<TaskResponse>({ success: true }, 200);
};
