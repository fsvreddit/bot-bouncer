import { TaskResponse } from "@devvit/web/server";
import type { Context } from "hono";
import { handleClientSubAnnouncements } from "../core";

export const handleClientSubAnnouncementsJob = async (c: Context): Promise<Response> => {
    await handleClientSubAnnouncements();

    return c.json<TaskResponse>({ message: "client sub announcements job completed" }, 200);
};
