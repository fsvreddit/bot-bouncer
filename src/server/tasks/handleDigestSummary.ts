import type { Context } from "hono";
import { TaskRequest, TaskResponse } from "@devvit/web/server";
import { sendDigestSummary } from "../core";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addSeconds } from "date-fns";

export const handleDigestSummaryJob = async (c: Context): Promise<Response> => {
    const request = await c.req.json<TaskRequest>();
    if (await hasEventBeenHandled(`job:${request.name}`, { expiration: addSeconds(new Date(), 10) })) {
        return c.json<TaskResponse>({ message: "Event has already been handled." }, 200);
    }

    await sendDigestSummary();

    return c.json<TaskResponse>({ success: true }, 200);
};
