/* eslint-disable @stylistic/quote-props */
import { TriggerContext, UserSocialLink, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { BIO_TEXT_STORE, getFullDataStore, SOCIAL_LINKS_STORE, UserDetails, UserFlag, UserStatus } from "../dataStore.js";
import Ajv, { JSONSchemaType } from "ajv";
import pluralize from "pluralize";
import json2md from "json2md";
import { addSeconds, format } from "date-fns";
import { setCleanupForUser } from "../cleanup.js";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";

interface ModmailDataExtract {
    status?: UserStatus[];
    submitter?: string;
    operator?: string;
    usernameRegex?: string;
    bioRegex?: string;
    socialLinkStartsWith?: string;
    evaluator?: string;
    hitReason?: string;
    flags?: UserFlag[];
    "~flags"?: UserFlag[];
    since?: string;
    recheck?: boolean;
}

const schema: JSONSchemaType<ModmailDataExtract> = {
    type: "object",
    properties: {
        status: {
            type: "array",
            items: {
                type: "string",
                enum: Object.values(UserStatus),
            },
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
        socialLinkStartsWith: {
            type: "string",
            nullable: true,
        },
        evaluator: {
            type: "string",
            nullable: true,
        },
        hitReason: {
            type: "string",
            nullable: true,
        },
        flags: {
            type: "array",
            items: {
                type: "string",
                enum: Object.values(UserFlag),
            },
            nullable: true,
        },
        "~flags": {
            type: "array",
            items: {
                type: "string",
                enum: Object.values(UserFlag),
            },
            nullable: true,
        },
        since: {
            type: "string",
            nullable: true,
            pattern: "^\\d{4}-\\d{2}-\\d{2}$", // YYYY-MM-DD format
        },
        recheck: {
            type: "boolean",
            nullable: true,
        },
    },
    additionalProperties: false,
};

type UserDetailsWithBioAndSocialLinks = UserDetails & { bioText?: string; socialLinks?: string };

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

    const atLeastOneRequiredFields = ["status", "submitter", "usernameRegex", "since", "flags"];
    if (!atLeastOneRequiredFields.some(field => field in request)) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `Request is empty. Please provide at least one of the following fields: ${atLeastOneRequiredFields.map(field => `\`${field}\``).join(", ")}. \`bioRegex\` cannot be used on its own.`,
            isAuthorHidden: false,
        });
        return;
    }

    let usernameRegex: RegExp | undefined;
    if (request.usernameRegex) {
        try {
            usernameRegex = new RegExp(request.usernameRegex);
        } catch {
            await context.reddit.modMail.reply({
                conversationId,
                body: "Invalid regex provided for `usernameRegex`.",
                isAuthorHidden: false,
            });
            return;
        }
    }

    // Get all data from database.
    const allData = await getFullDataStore(context);
    let data = Object.entries(allData)
        .map(([username, data]) => ({ username, data: JSON.parse(data) as UserDetailsWithBioAndSocialLinks }))
        .filter((entry) => {
            if (request.status && !request.status.includes(entry.data.userStatus)) {
                return false;
            }

            if (request.submitter && entry.data.submitter !== request.submitter) {
                return false;
            }

            if (request.operator && entry.data.operator !== request.operator) {
                return false;
            }

            if (usernameRegex) {
                if (!usernameRegex.test(entry.username)) {
                    return false;
                }
            }

            if (request.flags) {
                if (!entry.data.flags || !request.flags.every(flag => entry.data.flags?.includes(flag))) {
                    return false;
                }
            }

            if (request["~flags"]) {
                if (request["~flags"].some(flag => entry.data.flags?.includes(flag))) {
                    return false;
                }
            }

            if (request.since && entry.data.reportedAt) {
                const sinceDate = new Date(request.since);
                if (new Date(entry.data.reportedAt) <= sinceDate) {
                    return false;
                }
            }

            return true; // Keep the entry if it passes all filters
        });

    console.log(`Filtered data: ${data.length} entries match the criteria.`);

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
                data[i].data.bioText = userBioText; // Store the bio text for the user
            }
        }

        data = data.filter(entry => entry.data.bioText);
        console.log(`Filtered data by bioRegex: ${request.bioRegex}, remaining entries: ${data.length}`);
    }

    if (request.socialLinkStartsWith) {
        const socialLinkPrefix = request.socialLinkStartsWith.toLowerCase();
        const socialLinks = await context.redis.hMGet(SOCIAL_LINKS_STORE, data.map(entry => entry.username));
        for (let i = 0; i < data.length; i++) {
            const userSocialLinks = socialLinks[i];
            if (userSocialLinks) {
                const link = JSON.parse(userSocialLinks) as UserSocialLink[];
                const matchingLink = link.find(l => l.outboundUrl.startsWith(socialLinkPrefix));
                if (matchingLink) {
                    data[i].data.socialLinks = matchingLink.outboundUrl;
                }
            }
        }

        data = data.filter(entry => entry.data.socialLinks);
        console.log(`Filtered data by socialLinkStartsWith: ${request.socialLinkStartsWith}, remaining entries: ${data.length}`);
    }

    if (request.evaluator || request.hitReason) {
        console.log(`Filtering data for ${data.length} entries by evaluator: ${request.evaluator}`);
        const evaluationResults: Record<string, EvaluationResult[]> = {};
        await Promise.all(data.map(async (entry) => {
            const results = await getAccountInitialEvaluationResults(entry.username, context);
            if (results.length > 0) {
                evaluationResults[entry.username] = await getAccountInitialEvaluationResults(entry.username, context);
            } else {
                evaluationResults[entry.username] = [];
            }
        }));

        data = data.filter(entry => evaluationResults[entry.username].some((result) => {
            if (request.evaluator && !result.botName.toLowerCase().includes(request.evaluator.toLowerCase())) {
                return false;
            }

            if (request.hitReason && !result.hitReason?.toLowerCase().includes(request.hitReason.toLowerCase())) {
                return false;
            }

            return true;
        }));
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

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, "data-extract");
    } catch {
        //
    }

    const includeFlags = data.some(entry => entry.data.flags && entry.data.flags.length > 0);

    const markdown: json2md.DataObject[] = [
        { p: `Data export for ${data.length} ${pluralize("user", data.length)}.` },
    ];

    const criteriaBullets: string[] = [];
    if (request.status) {
        criteriaBullets.push(`Status: ${request.status.join(", ")}`);
    }
    if (request.submitter) {
        criteriaBullets.push(`Submitter: ${request.submitter}`);
    }
    if (request.operator) {
        criteriaBullets.push(`Operator: ${request.operator}`);
    }
    if (request.usernameRegex) {
        criteriaBullets.push(`Username Regex: \`${request.usernameRegex}\``);
    }
    if (request.flags) {
        criteriaBullets.push(`Includes Flags: ${request.flags.join(", ")}`);
    }
    if (request["~flags"]) {
        criteriaBullets.push(`Excludes Flags: ${request["~flags"].join(", ")}`);
    }
    if (request.since) {
        criteriaBullets.push(`Reported Since: ${request.since}`);
    }
    if (request.bioRegex) {
        criteriaBullets.push(`Bio Regex: \`${request.bioRegex}\``);
    }
    if (request.socialLinkStartsWith) {
        criteriaBullets.push(`Social Link Starts With: ${request.socialLinkStartsWith}`);
    }
    if (request.evaluator) {
        criteriaBullets.push(`Evaluator: ${request.evaluator}`);
    }
    if (request.hitReason) {
        criteriaBullets.push(`Hit Reason: ${request.hitReason}`);
    }

    if (criteriaBullets.length > 0) {
        markdown.push({ p: "Criteria for this extract:" });
        markdown.push({ ul: criteriaBullets });
    }

    const headers = ["User", "Tracking Post", "Status", "Reported At", "Last Update", "Submitter", "Operator"];
    if (includeFlags) {
        headers.push("Flags");
    }
    if (request.bioRegex) {
        headers.push("Bio Text");
    }
    if (request.socialLinkStartsWith) {
        headers.push("Social Link");
    }

    const rows: string[][] = [];

    for (const entry of data) {
        const row: string[] = [
            `[${entry.username}](https://www.reddit.com/user/${entry.username})`,
            `https://redd.it/${entry.data.trackingPostId.substring(3)}`,
            entry.data.userStatus,
            entry.data.reportedAt ? format(new Date(entry.data.reportedAt), "yyyy-MM-dd") : "",
            entry.data.lastUpdate ? format(new Date(entry.data.lastUpdate), "yyyy-MM-dd") : "",
            entry.data.submitter ?? "",
            entry.data.operator ?? "unknown",
        ];

        if (includeFlags) {
            row.push(entry.data.flags?.join(", ") ?? "");
        }

        if (request.bioRegex) {
            row.push(entry.data.bioText ?? "");
        }

        if (request.socialLinkStartsWith) {
            row.push(entry.data.socialLinks ?? "");
        }

        rows.push(row);
    }

    markdown.push({ table: { headers, rows } });
    const content = json2md(markdown);

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

    const body: json2md.DataObject[] = [
        { p: `Data for ${data.length} ${pluralize("user", data.length)} exported to [wiki page](https://www.reddit.com/r/BotBouncer/wiki/${wikiPageName}?v=${result.revisionId}).` },
    ];

    if (request.recheck) {
        if (data.length > 200) {
            body.push({ p: "Recheck is enabled, but the number of users is too high. Please recheck manually or rerun with a smaller dataset." });
        } else {
            await Promise.all(data.map(entry => setCleanupForUser(entry.username, context.redis, addSeconds(new Date(), 1))));
            body.push({ p: "Users have been queued for recheck, please run the extract again in around 20-30 minutes." });
        }
    }

    await context.reddit.modMail.reply({
        conversationId,
        body: json2md(body),
        isAuthorHidden: false,
    });
}
