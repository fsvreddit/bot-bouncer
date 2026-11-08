import { Context } from "hono";
import { getUserStatus } from "../core";

export const handleGetUserDetails = async (c: Context): Promise<Response> => {
    const username = c.req.query("username");

    if (!username) {
        return c.json({ error: "Username is required" }, 400);
    }

    const userDetails = await getUserStatus(username);
    if (!userDetails) {
        return c.json({ error: "User not found" }, 404);
    }

    return c.json(userDetails, 200);
};
