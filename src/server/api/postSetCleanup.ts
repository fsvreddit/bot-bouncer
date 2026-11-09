import { Context } from "hono";
import { setCleanupForUser } from "../core";

interface PostSetCleanupRequest {
    username: string;
    cleanupAt: number;
}

export const handlePostSetCleanup = async (c: Context): Promise<Response> => {
    const request = await c.req.json<PostSetCleanupRequest | PostSetCleanupRequest[] | undefined>();

    if (!request) {
        return c.json({ error: "Request body is required" }, 400);
    }

    let cleanupRequests: PostSetCleanupRequest[];
    if (Array.isArray(request)) {
        cleanupRequests = request;
    } else {
        cleanupRequests = [request];
    }

    for (const cleanupRequest of cleanupRequests) {
        await setCleanupForUser(cleanupRequest.username, new Date(cleanupRequest.cleanupAt));
    }

    return c.json({ success: true }, 200);
};
