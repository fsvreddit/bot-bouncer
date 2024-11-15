import { TriggerContext } from "@devvit/public-api";
import { ModAction } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { removeRecordOfBan } from "./dataStore.js";
import { createExternalSubmissionJob } from "./externalSubmissions.js";

export async function handleModAction (event: ModAction, context: TriggerContext) {
    if (event.action === "unbanuser" && event.targetUser && context.subredditName !== CONTROL_SUBREDDIT) {
        await removeRecordOfBan([event.targetUser.name], context);
    }

    if (event.action === "wikirevise" && context.subredditName === CONTROL_SUBREDDIT) {
        await createExternalSubmissionJob(context);
    }
}
