/* eslint-disable @stylistic/quote-props */
import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext, UserSocialLink, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { BIO_TEXT_STORE, DISPLAY_NAME_STORE, getFullDataStore, SOCIAL_LINKS_STORE, UserDetails, UserFlag, UserStatus } from "../dataStore.js";
import Ajv, { JSONSchemaType } from "ajv";
import pluralize from "pluralize";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
import { addSeconds, format } from "date-fns";
import { setCleanupForUser } from "../cleanup.js";
import { getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { ModmailMessage } from "./modmail.js";
import _ from "lodash";
import { ControlSubredditJob } from "../constants.js";
import { hMGetAsRecord } from "devvit-helpers";

interface ModmailDataExtract {
    status?: UserStatus[];
    submitter?: string;
    operator?: string;
    usernameRegex?: string;
    bioRegex?: string;
    displayNameRegex?: string;
    socialLinkStartsWith?: string;
    socialLinkUrlRegex?: string;
    socialLinkTitleRegex?: string;
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
            items: { type: "string", enum: Object.values(UserStatus) },
            nullable: true,
        },
        submitter: { type: "string", nullable: true },
        operator: { type: "string", nullable: true },
        usernameRegex: { type: "string", nullable: true },
        bioRegex: { type: "string", nullable: true },
        displayNameRegex: { type: "string", nullable: true },
        socialLinkStartsWith: { type: "string", nullable: true },
        socialLinkUrlRegex: { type: "string", nullable: true },
        socialLinkTitleRegex: { type: "string", nullable: true },
        evaluator: { type: "string", nullable: true },
        hitReason: { type: "string", nullable: true },
        flags: {
            type: "array",
            items: { type: "string", enum: Object.values(UserFlag) },
            nullable: true,
        },
        "~flags": {
            type: "array",
            items: { type: "string", enum: Object.values(UserFlag) },
            nullable: true,
        },
        since: { type: "string", nullable: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        recheck: { type: "boolean", nullable: true },
    },
    additionalProperties: false,
};

type UserDetailsWithBioAndSocialLinks = UserDetails & { bioText?: string; displayName?: string; socialLinks?: string };

function getExtractTempStoreKey (extractId: string) {
    return `ModmailDataExtract~${extractId}`;
}

function getExtractTempQueueKey (extractId: string) {
    return `ModmailDataExtractQueue~${extractId}`;
}

export async function dataExtract (message: ModmailMessage, conversationId: string, context: TriggerContext) {
    if (!message.bodyMarkdown.startsWith("!extract {")) {
        return;
    }

    console.log("Data Extract: Starting extract process.");

    const requestData = message.bodyMarkdown.slice(9);

    let request: ModmailDataExtract;
    try {
        request = JSON.parse(requestData) as ModmailDataExtract;
    } catch (error) {
        await context.reddit.modMail.reply({
            conversationId,
            body: tsMarkdown([
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
            body: tsMarkdown([
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

    if (request.bioRegex) {
        try {
            new RegExp(request.bioRegex);
        } catch {
            await context.reddit.modMail.reply({
                conversationId,
                body: "Invalid regex provided for `bioRegex`.",
                isAuthorHidden: false,
            });
            return;
        }
    }

    if (request.displayNameRegex) {
        try {
            new RegExp(request.displayNameRegex);
        } catch {
            await context.reddit.modMail.reply({
                conversationId,
                body: "Invalid regex provided for `displayNameRegex`.",
                isAuthorHidden: false,
            });
            return;
        }
    }

    // Get all data from database.
    const allData = await getFullDataStore(context);
    const data = Object.entries(allData)
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

    console.log(`Data Extract: Filtered data: ${data.length} entries match the criteria.`);

    const extractId = Date.now().toString();

    await Promise.all(_.chunk(data, 10000).map(async (dataChunk) => {
        const dataToStore = _.fromPairs(dataChunk.map(entry => [entry.username, JSON.stringify(entry.data)]));
        await context.redis.hSet(getExtractTempStoreKey(extractId), dataToStore);
        await context.redis.zAdd(getExtractTempQueueKey(extractId), ...dataChunk.map(entry => ({ score: 0, member: entry.username })));
    }));

    await context.redis.expire(getExtractTempStoreKey(extractId), 3600); // 1 hour expiry
    await context.redis.expire(getExtractTempQueueKey(extractId), 3600); // 1 hour expiry

    console.log("Data Extract: Queuing data extract continuation job.");

    await context.scheduler.runJob({
        name: ControlSubredditJob.DataExtractJob,
        runAt: new Date(),
        data: {
            extractId,
            conversationId,
            request: JSON.stringify(request),
            firstRun: true,
        },
    });

    let complicatedExtract = false;
    if (request.bioRegex || request.displayNameRegex || request.socialLinkStartsWith || request.socialLinkTitleRegex || request.socialLinkUrlRegex || request.evaluator || request.hitReason) {
        complicatedExtract = true;
    }

    if (complicatedExtract && data.length > 5000) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `This data extract uses filters that require additional processing. ${data.length.toLocaleString()} users match the initial "simple" criteria, which means that the extract will take some time to process. Please wait for a follow-up message once the extract is complete.`,
            isAuthorHidden: false,
        });
        return;
    }
}

export async function continueDataExtract (event: ScheduledJobEvent<JSONObject | undefined>, context: TriggerContext) {
    const extractId = event.data?.extractId as string | undefined;
    const conversationId = event.data?.conversationId as string | undefined;
    const request = event.data?.request ? JSON.parse(event.data.request as string) as ModmailDataExtract : undefined;

    if (!extractId || !conversationId || !request) {
        console.error("Data Extract: Missing extractId, conversationId, or request data extract job");
        return;
    }

    if (!request.bioRegex && !request.displayNameRegex && !request.socialLinkStartsWith && !request.evaluator && !request.hitReason && !request.socialLinkUrlRegex && !request.socialLinkTitleRegex) {
        await createDataExtract(extractId, request, conversationId, context);
        return;
    }

    const entriesToRemove = new Set<string>();
    const entriesToRewrite = new Set<string>();
    const batchSize = request.evaluator || request.hitReason ? 400 : 2000;
    const processingQueueData = await context.redis.zRange(getExtractTempQueueKey(extractId), 0, batchSize - 1);
    const processingQueue = processingQueueData.map(entry => entry.member);

    if (processingQueue.length === 0) {
        console.log("Data Extract: No more entries to process, finalizing extract.");
        await createDataExtract(extractId, request, conversationId, context);
        return;
    }

    const rawData = await hMGetAsRecord(context.redis, getExtractTempStoreKey(extractId), processingQueue);
    const dataMapped = Object.entries(rawData)
        .map(([username, data]) => ({ username, data: JSON.parse(data) as UserDetailsWithBioAndSocialLinks }));

    const data = _.fromPairs(dataMapped.map(entry => [entry.username, entry.data]));

    console.log(`Data Extract: Processing batch of ${processingQueue.length} entries.`);

    if (request.bioRegex) {
        const regex = new RegExp(request.bioRegex);
        const bioTexts = await hMGetAsRecord(context.redis, BIO_TEXT_STORE, processingQueue);

        for (const username of processingQueue) {
            if (bioTexts[username] && regex.test(bioTexts[username])) {
                data[username].bioText = bioTexts[username];
                entriesToRewrite.add(username);
            } else {
                entriesToRemove.add(username);
            }
        }
    }

    if (request.displayNameRegex) {
        const regex = new RegExp(request.displayNameRegex);
        const displayNames = await hMGetAsRecord(context.redis, DISPLAY_NAME_STORE, processingQueue);
        for (const username of processingQueue) {
            if (displayNames[username] && regex.test(displayNames[username])) {
                data[username].displayName = displayNames[username];
                entriesToRewrite.add(username);
            } else {
                entriesToRemove.add(username);
            }
        }
    }

    if (request.socialLinkStartsWith || request.socialLinkUrlRegex || request.socialLinkTitleRegex) {
        const socialLinks = await hMGetAsRecord(context.redis, SOCIAL_LINKS_STORE, processingQueue);

        const socialLinkPrefix = request.socialLinkStartsWith?.toLowerCase();
        const socialLinkUrlRegex = request.socialLinkUrlRegex ? new RegExp(request.socialLinkUrlRegex) : undefined;
        const socialLinkTitleRegex = request.socialLinkTitleRegex ? new RegExp(request.socialLinkTitleRegex) : undefined;

        for (const username of processingQueue) {
            const userSocialLinks = socialLinks[username];
            if (userSocialLinks) {
                const link = JSON.parse(userSocialLinks) as UserSocialLink[];
                const matchingLink = link.find((l) => {
                    if (socialLinkPrefix && !l.outboundUrl.startsWith(socialLinkPrefix)) {
                        return false;
                    }
                    if (socialLinkUrlRegex && !l.outboundUrl.match(socialLinkUrlRegex)) {
                        return false;
                    }
                    if (socialLinkTitleRegex && !l.title.match(socialLinkTitleRegex)) {
                        return false;
                    }
                    return true;
                });
                if (matchingLink) {
                    data[username].socialLinks = matchingLink.outboundUrl;
                    entriesToRewrite.add(username);
                } else {
                    entriesToRemove.add(username);
                }
            } else {
                entriesToRemove.add(username);
            }
        }
    }

    if (request.evaluator || request.hitReason) {
        await Promise.all(processingQueue.map(async (username) => {
            const results = await getAccountInitialEvaluationResults(username, context);
            if (results.length === 0) {
                entriesToRemove.add(username);
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            if (request.evaluator && !results.some(result => result.botName.toLowerCase().includes(request.evaluator!.toLowerCase()))) {
                entriesToRemove.add(username);
                return;
            }

            if (request.hitReason && !results.some((result) => {
                if (!result.hitReason) {
                    return false;
                }

                if (typeof result.hitReason === "string") {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    return result.hitReason.toLowerCase().includes(request.hitReason!.toLowerCase());
                }

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                return result.hitReason.reason.toLowerCase().includes(request.hitReason!.toLowerCase());
            })) {
                entriesToRemove.add(username);
                return;
            }
        }));
    }

    if (entriesToRemove.size > 0) {
        console.log(`Data Extract: Removing ${entriesToRemove.size} entries that did not match additional criteria.`);
        await context.redis.hDel(getExtractTempStoreKey(extractId), Array.from(entriesToRemove));
    }

    if (entriesToRewrite.size > 0) {
        const rewrittenData = _.fromPairs(Array.from(entriesToRewrite).map(username => [username, JSON.stringify(data[username])]));
        await context.redis.hSet(getExtractTempStoreKey(extractId), rewrittenData);
    }

    await context.redis.zRem(getExtractTempQueueKey(extractId), processingQueue);

    await context.scheduler.runJob({
        name: ControlSubredditJob.DataExtractJob,
        runAt: addSeconds(new Date(), 1),
        data: {
            extractId,
            conversationId,
            request: JSON.stringify(request),
        },
    });
}

async function createDataExtract (
    extractId: string,
    request: ModmailDataExtract,
    conversationId: string,
    context: JobContext,
) {
    const keys = await context.redis.hKeys(getExtractTempStoreKey(extractId));
    if (keys.length > 5000) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `The data to export includes ${keys.length} records which exceeds the maximum of 5000. Detailed data cannot be shown.`,
        });

        await context.redis.del(getExtractTempStoreKey(extractId));
        await context.redis.del(getExtractTempQueueKey(extractId));
    }

    const rawData = await context.redis.hGetAll(getExtractTempStoreKey(extractId));
    const data = Object.entries(rawData)
        .map(([username, data]) => ({ username, data: JSON.parse(data) as UserDetailsWithBioAndSocialLinks }));

    await context.redis.del(getExtractTempStoreKey(extractId));
    await context.redis.del(getExtractTempQueueKey(extractId));

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

    const markdown: MarkdownEntry[] = [
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
    if (request.displayNameRegex) {
        criteriaBullets.push(`Display Name Regex: \`${request.displayNameRegex}\``);
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
    const content = tsMarkdown(markdown);

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

    const body: MarkdownEntry[] = [
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
        body: tsMarkdown(body),
        isAuthorHidden: false,
    });
}
