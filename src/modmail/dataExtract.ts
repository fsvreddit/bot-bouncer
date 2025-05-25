import { TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { BIO_TEXT_STORE, UserDetails, UserStatus } from "../dataStore.js";
import Ajv, { JSONSchemaType } from "ajv";
import { fromPairs } from "lodash";
import pluralize from "pluralize";
import json2md from "json2md";
import { format } from "date-fns";

interface ModmailDataExtract {
    status?: UserStatus;
    submitter?: string;
    operator?: string;
    usernameRegex?: string;
    bioRegex?: string;
    since?: string;
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
        bioRegex: {
            type: "string",
            nullable: true,
        },
        since: {
            type: "string",
            nullable: true,
            pattern: "^\\d{4}-\\d{2}-\\d{2}$", // YYYY-MM-DD format
        },
    },
    additionalProperties: false,
};

interface FriendlyUserDetails {
    postId: string;
    userStatus: UserStatus;
    reportedAt?: string;
    lastUpdate: string;
    submitter?: string;
    operator: string;
    bioText?: string;
}

function userDetailsToFriendly (details: UserDetails): FriendlyUserDetails {
    return {
        postId: details.trackingPostId,
        userStatus: details.userStatus,
        reportedAt: details.reportedAt ? format(new Date(details.reportedAt), "yyyy-MM-dd") : undefined,
        lastUpdate: format(new Date(details.lastUpdate), "yyyy-MM-dd"),
        submitter: details.submitter,
        operator: details.operator,
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        bioText: details.bioText,
    };
}

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
        console.log(`Filtered data by status: ${request.status}, remaining entries: ${data.length}`);
    }

    if (request.submitter) {
        data = data.filter(entry => entry.data.submitter === request.submitter);
        console.log(`Filtered data by submitter: ${request.submitter}, remaining entries: ${data.length}`);
    }

    if (request.operator) {
        data = data.filter(entry => entry.data.operator === request.operator);
        console.log(`Filtered data by operator: ${request.operator}, remaining entries: ${data.length}`);
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
        console.log(`Filtered data by usernameRegex: ${request.usernameRegex}, remaining entries: ${data.length}`);
    }

    if (request.since) {
        const sinceDate = new Date(request.since);
        data = data.filter(entry => entry.data.reportedAt && new Date(entry.data.reportedAt) > sinceDate);
        console.log(`Filtered data by since date: ${request.since}, remaining entries: ${data.length}`);
    }

    if (request.bioRegex) {
        let regex: RegExp;
        try {
            regex = new RegExp(request.bioRegex);
        } catch {
            await context.reddit.modMail.reply({
                conversationId,
                body: "Invalid regex provided for `bioRegex`.",
                isAuthorHidden: false,
            });
            return;
        }
        const bioTexts = await context.redis.hMGet(BIO_TEXT_STORE, data.map(entry => entry.username));
        for (let i = 0; i < data.length; i++) {
            const userBioText = bioTexts[i];
            if (userBioText && regex.test(userBioText)) {
                // eslint-disable-next-line @typescript-eslint/no-deprecated
                data[i].data.bioText = userBioText; // Store the bio text for the user
            }
        }

        // eslint-disable-next-line @typescript-eslint/no-deprecated
        data = data.filter(entry => entry.data.bioText);
        console.log(`Filtered data by bioRegex: ${request.bioRegex}, remaining entries: ${data.length}`);
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
    const dataToExport = fromPairs(data.map(entry => [entry.username, userDetailsToFriendly(entry.data)]));

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, "data-extract");
    } catch {
        //
    }

    const content = JSON.stringify(dataToExport);
    if (content.length > 512 * 1024) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `The data to export includes ${data.length} records and exceeds the maximum size of 512KB. Please refine your request.`,
            isAuthorHidden: false,
        });
        return;
    }

    const result = await context.reddit.updateWikiPage({
        subredditName,
        page: wikiPageName,
        content,
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
