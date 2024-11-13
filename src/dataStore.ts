import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage } from "@devvit/public-api";
import { setCleanupForUser } from "./cleanup.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { toPairs } from "lodash";

const USER_STORE = "UserStore";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "BotBouncer";

export enum UserStatus {
    Pending = "pending",
    Banned = "banned",
    Service = "service",
    Organic = "organic",
    Purged = "purged",
    Retired = "retired",
}

interface UserDetails {
    trackingPostId: string;
    userStatus: UserStatus;
    lastUpdate: Date;
    operator: string;
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.hGet(USER_STORE, username);
    if (!value) {
        return;
    }

    return JSON.parse(value) as UserDetails;
}

export async function setUserStatus (username: string, details: UserDetails, context: TriggerContext) {
    await context.redis.hSet(USER_STORE, { [username]: JSON.stringify(details) });
    await setCleanupForUser(username, context);
    await queueWikiUpdate(context);
}

async function queueWikiUpdate (context: TriggerContext) {
    await context.redis.set(WIKI_UPDATE_DUE, "true");
}

export async function updateWikiPage (_: unknown, context: JobContext) {
    const updateDue = await context.redis.get(WIKI_UPDATE_DUE);
    if (!updateDue) {
        return;
    }

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, WIKI_PAGE);
    } catch {
        //
    }

    const data = await context.redis.hGetAll(USER_STORE);
    if (Object.entries(data).length === 0) {
        return;
    }

    const content = JSON.stringify(data);
    if (content === wikiPage?.content) {
        return;
    }

    const wikiUpdateOptions = {
        subredditName,
        content,
        page: WIKI_PAGE,
    };

    if (wikiPage) {
        await context.reddit.updateWikiPage(wikiUpdateOptions);
    } else {
        await context.reddit.createWikiPage(wikiUpdateOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName,
            listed: true,
            page: WIKI_PAGE,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }

    await context.redis.del(WIKI_UPDATE_DUE);

    console.log("Wiki page has been updated");
}

export async function updateLocalStoreFromWiki (_: unknown, context: JobContext) {
    const lastUpdateKey = "lastUpdateFromWiki";

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
    } catch {
        console.log("Wiki page does not exist on control subreddit");
        return;
    }

    const lastUpdate = await context.redis.get(lastUpdateKey);
    if (!lastUpdate || lastUpdate === wikiPage.revisionId) {
        return;
    }

    const incomingData = JSON.parse(wikiPage.content) as Record<string, string>;
    await context.redis.del(USER_STORE);

    if (Object.keys(incomingData).length === 0) {
        return;
    }

    for (const [username, userData] of toPairs(incomingData)) {
        await context.redis.hSet(USER_STORE, { [username]: userData });
    }
}
