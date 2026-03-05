import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getFullDataStore, UserStatus } from "./dataStore.js";
import { subWeeks } from "date-fns";
import { compressData } from "./utility.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import pluralize from "pluralize";

export async function doBotSleuthBotExtract (_event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("BotSleuthBot extract job can only be run on the control subreddit");
    }

    console.log("BSB Extract: Starting BotSleuthBot extract job");

    const allData = await getFullDataStore(context, {
        lastUpdateSince: subWeeks(new Date(), 6),
    });

    console.log(`BSB Extract: Retrieved ${Object.keys(allData).length} users from data store`);

    const output: Record<string, string[]> = {};

    for (const [username, details] of Object.entries(allData)) {
        let statusKey: UserStatus;
        if (details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) {
            statusKey = details.lastStatus ?? details.userStatus;
        } else {
            statusKey = details.userStatus;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!output[statusKey]) {
            output[statusKey] = [];
        }
        output[statusKey].push(username);
    }

    for (const key of Object.keys(output)) {
        output[key].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }

    const compressedOutput = compressData(output);

    console.log(`BSB Extract: Compressed output size is ${compressedOutput.length} bytes`);

    const extractRoot = "botsleuthbot-extract";
    const maxWikiPageSize = 512 * 1024; // 512 KB
    const splitOutput: string[] = [];
    for (let i = 0; i < compressedOutput.length; i += maxWikiPageSize) {
        splitOutput.push(compressedOutput.slice(i, i + maxWikiPageSize));
    }

    if (splitOutput.length === 1) {
        splitOutput.push("");
    }

    for (let i = 0; i < splitOutput.length; i++) {
        const pageName = `${extractRoot}/${i}`;
        await context.reddit.updateWikiPage({
            subredditName: CONTROL_SUBREDDIT,
            page: pageName,
            content: splitOutput[i],
        });
    }

    console.log(`BSB Extract: Finished updating ${splitOutput.length} wiki ${pluralize("page", splitOutput.length)} for BotSleuthBot extract`);
}
