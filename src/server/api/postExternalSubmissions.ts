import { Context } from "hono";
import { addExternalSubmissionFromExternal } from "../core";
import { ExternalSubmission } from "@fsvreddit/bot-bouncer-types";

export const handlePostExternalSubmissions = async (c: Context): Promise<Response> => {
    if (c.req.method !== "POST") {
        return c.json({ error: "Method not allowed" }, 405);
    }

    const request = await c.req.json<ExternalSubmission | ExternalSubmission[] | undefined>();

    if (!request) {
        return c.json({ error: "Request body is required" }, 400);
    }

    let externalSubmissions: ExternalSubmission[];
    if (Array.isArray(request)) {
        externalSubmissions = request;
    } else {
        externalSubmissions = [request];
    }

    for (const submission of externalSubmissions) {
        await addExternalSubmissionFromExternal(submission);
    }

    return c.json({ success: true }, 200);
};
