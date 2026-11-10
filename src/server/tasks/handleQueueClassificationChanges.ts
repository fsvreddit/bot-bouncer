import { TaskRequest, TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { queueRecentReclassifications } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addSeconds } from "date-fns";

export const handleQueueClassificationChangesJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest>();
    if (await hasEventBeenHandled(`job:${request.name}`, { expiration: addSeconds(new Date(), 10) })) {
        return c.json<TaskResponse>({ message: "Event has already been handled." }, 200);
    }

    await queueRecentReclassifications();

    return c.json<TaskResponse>({ message: "Queued recent reclassifications successfully." }, 200);
};
