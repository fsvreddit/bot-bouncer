import { JobContext, JSONObject, ScheduledJobEvent, UpdateWikiPageOptions } from "@devvit/public-api";
import { differenceInSeconds } from "date-fns";

export async function asyncWikiUpdate (event: ScheduledJobEvent<JSONObject>, context: JobContext) {
    const now = Date.now();
    const data = event.data as UpdateWikiPageOptions;

    try {
        await context.reddit.updateWikiPage(data);
    } catch (error) {
        console.error(`Failed to update wiki page after ${differenceInSeconds(new Date(), now)} seconds: ${data.page}`, error);
    }
    console.log(`Updated wiki page: ${data.page}`);
}
