import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { AppSetting } from "./settings.js";
import { addExternalSubmissionFromClientSub, ExternalSubmission } from "./externalSubmissions.js";
import { getUserStatus } from "./dataStore.js";

export async function checkForBanNotes (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        console.error("Ban note check: This job should not be run on the control subreddit");
        return;
    }

    if (!await context.settings.get<boolean>(AppSetting.ReportPotentialBots)) {
        return;
    }

    const username = event.data?.username as string | undefined;
    if (!username) {
        console.error("Ban note check: No username provided in job data");
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const modLog = await context.reddit.getModerationLog({
        subredditName,
        type: "banuser",
        limit: 25,
    }).all();

    const entry = modLog.find(entry => entry.target?.author === username && entry.moderatorName !== context.appName);
    if (!entry) {
        console.log(`Ban note check: No ban entry found for ${username}`);
        return;
    }

    if (!entry.description) {
        return;
    }

    const regex = /\b(?:AI|ChatGPT|LLM|bot|spambot)\b/i;
    if (!regex.test(entry.description)) {
        console.log(`Ban note check: No AI-related terms found in ban entry for ${username}`);
        return;
    }

    const userStatus = await getUserStatus(username, context);
    if (userStatus) {
        console.log(`Ban note check: User ${username} already has a status of ${userStatus.userStatus}`);
        return;
    }

    const submission: ExternalSubmission = {
        username,
        reportContext: "User was banned from a subreddit for being a bot.",
    };

    await addExternalSubmissionFromClientSub(submission, "automatic", context);
}
