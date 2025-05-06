import { TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserDetails, UserStatus } from "../dataStore.js";
import Ajv, { JSONSchemaType } from "ajv";
import { fromPairs } from "lodash";
import pluralize from "pluralize";
import { getYear } from "date-fns";
import json2md from "json2md";

interface ModmailDataExtract {
    status?: UserStatus;
    submitter?: string;
    operator?: string;
    usernameRegex?: string;
    since?: number;
}

const schema: JSONSchemaType<ModmailDataExtract> = {
    type: "object",
    properties: {
        status: {
            type: "string",
            nullable: true,
        },
        submitter: {
            type: "string",
            nullable: true,
        },
        operator: {
            type: "string",
            nullable: true,
        },
        usernameRegex: {
            type: "string",
            nullable: true,
        },
        since: {
            type: "number",
            nullable: true,
        },
    },
    additionalProperties: false,
};

export async function dataExtract (message: string | undefined, conversationId: string, context: TriggerContext) {
    if (!message?.startsWith("!extract {")) {
        return;
    }

    console.log("Extracting data");

    const requestData = message.slice(9);

    let request: ModmailDataExtract;
    try {
        request = JSON.parse(requestData) as ModmailDataExtract;
    } catch (error) {
        await context.reddit.modMail.reply({
            conversationId,
            body: json2md([
                { p: "Error parsing JSON" },
                { blockquote: error },
            ]),
            isAuthorHidden: false,
        });
        return;
    }

    const ajv = new Ajv.default({ coerceTypes: "array" });
    const validate = ajv.compile(schema);

    if (!validate(request)) {
        await context.reddit.modMail.reply({
            conversationId,
            body: json2md([
                { p: "Invalid JSON" },
                { blockquote: ajv.errorsText(validate.errors) },
            ]),
            isAuthorHidden: false,
        });
        return;
    }

    if (!request.status && !request.submitter && !request.usernameRegex) {
        await context.reddit.modMail.reply({
            conversationId,
            body: "Request is empty. Please provide at least one of the following fields: `status`, `submitter`, `usernameRegex`, `bioTextRegex`, `recentPostSubs`, `recentCommentSubs`.",
            isAuthorHidden: false,
        });
        return;
    }

    // Get all data from database.
    const allData = await context.redis.hGetAll("UserStore");
    let data = Object.entries(allData).map(([username, data]) => ({ username, data: JSON.parse(data) as UserDetails }));

    // Filter data by request fields.
    if (request.status) {
        data = data.filter(entry => entry.data.userStatus === request.status);
    }

    if (request.submitter) {
        data = data.filter(entry => entry.data.submitter === request.submitter);
    }

    if (request.operator) {
        data = data.filter(entry => entry.data.operator === request.operator);
    }

    if (request.usernameRegex) {
        let regex: RegExp;
        try {
            regex = new RegExp(request.usernameRegex);
        } catch {
            await context.reddit.modMail.reply({
                conversationId,
                body: "Invalid regex provided for `usernameRegex`.",
                isAuthorHidden: false,
            });
            return;
        }
        data = data.filter(entry => regex.test(entry.username));
    }

    if (request.since) {
        if (getYear(new Date(request.since)) < 2024) {
            // Probably a timestamp with seconds instead of milliseconds.
            request.since *= 1000;
        }
        data = data.filter(entry => entry.data.lastUpdate && request.since !== undefined && entry.data.lastUpdate > request.since);
    }

    if (data.length === 0) {
        await context.reddit.modMail.reply({
            conversationId,
            body: "No records found with the provided criteria.",
            isAuthorHidden: false,
        });
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const wikiPageName = "data-extract";
    const dataToExport = fromPairs(data.map(entry => [entry.username, entry.data]));

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, "data-extract");
    } catch {
        //
    }

    const result = await context.reddit.updateWikiPage({
        subredditName,
        page: wikiPageName,
        content: JSON.stringify(dataToExport),
    });

    if (!wikiPage) {
        await context.reddit.updateWikiPageSettings({
            subredditName,
            page: wikiPageName,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
            listed: true,
        });
    }

    await context.reddit.modMail.reply({
        conversationId,
        body: `Data for ${data.length} ${pluralize("user", data.length)} exported to [wiki page](https://www.reddit.com/r/BotBouncer/wiki/${wikiPageName}?v=${result.revisionId}).`,
        isAuthorHidden: false,
    });
}
