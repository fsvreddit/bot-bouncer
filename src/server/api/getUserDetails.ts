import { Context } from "hono";
import { getUserStatus } from "../core";

export const handleGetUserDetails = async (c: Context): Promise<Response> => {
    if (c.req.method !== "GET") {
        return c.json({ error: "Method not allowed" }, 405);
    }

    const username = c.req.param("username");
    if (!username) {
        return c.json({ error: "Username is required" }, 400);
    }

    const userDetails = await getUserStatus(username);
    if (!userDetails) {
        return c.json({ error: "User not found" }, 404);
    }

    return c.json(userDetails, 200);
};
