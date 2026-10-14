import type { Context } from "hono";
import { TriggerResponse } from "@devvit/web/shared";
import { handleInstallTasks } from "../core";

export const onAppUpgrade = async (c: Context): Promise<Response> => {
    console.log("App Upgrade: Triggered");

    await handleInstallTasks();

    return c.json<TriggerResponse>({ message: "app upgraded" }, 200);
};
