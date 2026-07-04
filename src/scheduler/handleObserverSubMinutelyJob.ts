import { JobContext } from "@devvit/public-api";
import { getControlSubSettings } from "../settings.js";
import { handleExternalSubmissionsPageUpdate } from "../externalSubmissions.js";

export async function handleObserverSubMinutelyJob (_: unknown, context: JobContext) {
    if (!context.subredditName) {
        throw new Error("Observer sub minutely jobs must be run in a subreddit.");
    }

    const controlSubSettings = await getControlSubSettings(context);
    const observerSubs = new Set(controlSubSettings.observerSubreddits ?? []);
    if (!observerSubs.has(context.subredditName)) {
        throw new Error("Observer sub minutely jobs are only run in observer subreddits.");
    }

    await handleExternalSubmissionsPageUpdate(context);
}
