import { context, TaskResponse } from "@devvit/web/server";
import { Context } from "hono";
import { getControlSubSettings, handleExternalSubmissionsPageUpdate } from "../core";

export const handleObserverSubMinutelyJob = async (c: Context): Promise<Response> => {
    const controlSubSettings = await getControlSubSettings();
    const observerSubs = new Set(controlSubSettings.observerSubreddits ?? []);
    if (!observerSubs.has(context.subredditName)) {
        throw new Error("Observer sub minutely jobs are only run in observer subreddits.");
    }

    await handleExternalSubmissionsPageUpdate();

    return c.json<TaskResponse>({ message: "Observer sub minutely job completed successfully." }, 200);
};
