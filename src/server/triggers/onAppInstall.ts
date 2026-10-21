import type { Context } from "hono";
import { TriggerResponse } from "@devvit/web/shared";
import { handleInstallTasks } from "../core";

export const onAppInstall = async (c: Context): Promise<Response> => {
    console.log("App Install: Triggered");

    await handleInstallTasks();

    return c.json<TriggerResponse>({ message: "app installed" }, 200);
};
