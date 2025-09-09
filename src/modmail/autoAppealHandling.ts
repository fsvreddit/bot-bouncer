/* eslint-disable @stylistic/quote-props */
import { TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { UserDetails, UserFlag, UserStatus } from "../dataStore.js";
import { getControlSubSettings } from "../settings.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { parseAllDocuments } from "yaml";
import { compact } from "lodash";
import json2md from "json2md";
import { getUserSocialLinks, replaceAll, sendMessageToWebhook } from "../utility.js";
import { ModmailMessage } from "./modmail.js";
import { getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { getUserExtended } from "../extendedDevvit.js";
import { statusToFlair } from "../postCreation.js";
import { format, getYear } from "date-fns";
import { getPossibleSetStatusValues } from "./controlSubModmail.js";

const APPEAL_CONFIG_WIKI_PAGE = "appeal-config";
const APPEAL_CONFIG_REDIS_KEY = "AppealConfig";

interface AppealConfig {
    name: string;
    priority?: number;
    submitter?: string;
    operator?: string;
    usernameRegex?: string[];
    messageBodyRegex?: string[];
    banDateFrom?: string;
    banDateTo?: string;
    evaluatorNameRegex?: string;
    evaluatorHitReasonRegex?: string[];
    bioRegex?: string[];
    "~bioRegex"?: string[];
    socialLinkRegex?: string[];
    "~socialLinkRegex"?: string[];
    flags?: UserFlag[];
    "~flags"?: UserFlag[];
    setStatus?: string;
    privateReply?: string;
    reply?: string;
    archive?: boolean;
    mute?: number;
}

const acceptableMuteDurations = [3, 7, 28];

const appealConfigSchema: JSONSchemaType<AppealConfig[]> = {
    type: "array",
    items: {
        type: "object",
        properties: {
            name: { type: "string" },
            priority: { type: "number", nullable: true },
            submitter: { type: "string", nullable: true },
            operator: { type: "string", nullable: true },
            usernameRegex: { type: "array", items: { type: "string" }, nullable: true },
            messageBodyRegex: { type: "array", items: { type: "string" }, nullable: true },
            banDateFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", nullable: true },
            banDateTo: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", nullable: true },
            evaluatorNameRegex: { type: "string", nullable: true },
            evaluatorHitReasonRegex: { type: "array", items: { type: "string" }, nullable: true },
            bioRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~bioRegex": { type: "array", items: { type: "string" }, nullable: true },
            socialLinkRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~socialLinkRegex": { type: "array", items: { type: "string" }, nullable: true },
            flags: { type: "array", items: { type: "string", enum: Object.values(UserFlag) }, nullable: true },
            "~flags": { type: "array", items: { type: "string", enum: Object.values(UserFlag) }, nullable: true },
            setStatus: { type: "string", enum: getPossibleSetStatusValues(), nullable: true },
            privateReply: { type: "string", nullable: true },
            reply: { type: "string", nullable: true },
            archive: { type: "boolean", nullable: true },
            mute: { type: "number", enum: acceptableMuteDurations, nullable: true },
        },
        additionalProperties: false,
        required: ["name"],
    },
};

interface AppealOutcome {
    name: string;
    newStatus?: string;
    privateReply?: string;
    reply?: string;
    archive?: boolean;
    mute?: number;
}

const defaultAppealOutcome: AppealOutcome = {
    name: "Default Appeal Reply",
    reply: `Your classification appeal has been received and will be reviewed by a moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.

If Bot Bouncer has banned you from more than one subreddit, you don't need to appeal separately.`,
};

function getSubstitutions (wikiPage: string): Record<string, string | string[]> {
    const documents = parseAllDocuments(wikiPage);

    const results: Record<string, string | string[]> = {};

    const substitutionDocument = documents
        .map(doc => doc.toJSON() as Record<string, unknown>)
        .find(doc => doc.name === "substitutions");

    if (!substitutionDocument) {
        return {};
    }

    for (const [key, value] of Object.entries(substitutionDocument)) {
        if (key === "name") {
            continue;
        }

        if (typeof value === "string" || Array.isArray(value)) {
            results[key] = value;
        }
    }

    return results;
}

export async function validateAndSaveAppealConfig (username: string, context: TriggerContext): Promise<void> {
    const appealConfigRevisionKey = "AppealConfigRevision";
    const wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, APPEAL_CONFIG_WIKI_PAGE);
    const lastAppealConfigRevision = await context.redis.get(appealConfigRevisionKey);
    if (wikiPage.revisionId === lastAppealConfigRevision) {
        // The saved config is up-to-date with the latest revision
        return;
    }

    const substitutions = getSubstitutions(wikiPage.content);

    let pageToParse = wikiPage.content;
    for (const [key, value] of Object.entries(substitutions)) {
        const valueToSubstitute = typeof value === "string" ? value : JSON.stringify(value);
        pageToParse = replaceAll(pageToParse, `{{${key}}}`, valueToSubstitute);
    }

    const documents = parseAllDocuments(pageToParse);

    const parsedConfigs = compact(documents.map(doc => doc.toJSON() as AppealConfig)).filter(item => item.name !== "substitutions");

    const ajv = new Ajv.default({
        coerceTypes: "array",
    });

    const validate = ajv.compile(appealConfigSchema);

    if (validate(parsedConfigs)) {
        // Save the valid config to Redis
        await context.redis.set(APPEAL_CONFIG_REDIS_KEY, JSON.stringify(parsedConfigs));
        await context.redis.set(appealConfigRevisionKey, wikiPage.revisionId);
        console.log(`Appeal config updated to revision ${wikiPage.revisionId}`);
        return;
    }

    if (validate.errors) {
        console.error("Invalid appeal config:", validate.errors);

        await context.reddit.sendPrivateMessage({
            to: username,
            subject: "Error in appeal configuration",
            text: json2md([
                { p: "There was an error in your appeal configuration:" },
                { blockquote: ajv.errorsText(validate.errors) },
            ]),
        });

        const webhookUrl = await getControlSubSettings(context).then(s => s.monitoringWebhook);
        if (webhookUrl) {
            await sendMessageToWebhook(webhookUrl, json2md([
                { p: `There was an error in the appeal configuration, last updated by ${username}:` },
                { p: "Last known good values will be used until this is corrected." },
                { ul: validate.errors.map(err => `${err.instancePath} ${err.message}`) },
            ]));
        }
    }
}

async function getAppealConfig (context: TriggerContext): Promise<AppealConfig[]> {
    const configData = await context.redis.get(APPEAL_CONFIG_REDIS_KEY);
    if (!configData) {
        return [];
    }

    return JSON.parse(configData) as AppealConfig[];
}

function formatPlaceholders (input: string, userDetails: UserDetails): string {
    let output = input;
    let dateFormat: string;
    const date = new Date(userDetails.reportedAt ?? userDetails.lastUpdate);
    if (getYear(date) !== getYear(new Date())) {
        dateFormat = "MMMM do, yyyy";
    } else {
        dateFormat = "MMMM do";
    }

    output = replaceAll(output, "{{classificationdate}}", format(new Date(userDetails.reportedAt ?? userDetails.lastUpdate), dateFormat));
    return output;
}

export async function handleAppeal (modmail: ModmailMessage, userDetails: UserDetails, context: TriggerContext): Promise<void> {
    const username = modmail.participant;
    if (!username) {
        return;
    }

    const appealConfig = await getAppealConfig(context).then(configs => configs.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)));
    const initialAccountEvaluationResults = await getAccountInitialEvaluationResults(username, context);
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const user = appealConfig.some(config => config.bioRegex || config["~bioRegex"]) ? await getUserExtended(username, context) : undefined;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const socialLinks = appealConfig.some(config => config.socialLinkRegex || config["~socialLinkRegex"]) ? await getUserSocialLinks(username, context) : [];

    const matchedAppealConfig = appealConfig.find((config) => {
        if (config.usernameRegex && !config.usernameRegex.some(regex => new RegExp(regex, "i").test(username))) {
            return;
        }

        if (config.messageBodyRegex && !config.messageBodyRegex.some(regex => new RegExp(regex, "i").test(modmail.bodyMarkdown))) {
            return;
        }

        if (config.banDateFrom && (userDetails.reportedAt ?? userDetails.lastUpdate) < new Date(config.banDateFrom).getTime()) {
            return;
        }

        if (config.banDateTo && (userDetails.reportedAt ?? userDetails.lastUpdate) > new Date(config.banDateTo).getTime()) {
            return;
        }

        if (config.submitter && config.submitter !== userDetails.submitter) {
            return;
        }

        if (config.operator && config.operator !== userDetails.operator) {
            return;
        }

        if (config.evaluatorNameRegex || config.evaluatorHitReasonRegex) {
            let anyMatched = false;
            for (const evaluationResult of initialAccountEvaluationResults) {
                if (config.evaluatorNameRegex && !new RegExp(config.evaluatorNameRegex, "i").test(evaluationResult.botName)) {
                    continue;
                }

                if (config.evaluatorHitReasonRegex && !config.evaluatorHitReasonRegex.some(regex => new RegExp(regex, "i").test(evaluationResult.hitReason ?? ""))) {
                    continue;
                }
                anyMatched = true;
            }

            if (!anyMatched) {
                return;
            }
        }

        if (config.bioRegex) {
            if (!user?.userDescription) {
                return;
            }

            if (!config.bioRegex.some(regex => new RegExp(regex, "i").test(user.userDescription ?? ""))) {
                return;
            }
        }

        if (config["~bioRegex"] && user?.userDescription) {
            if (config["~bioRegex"].some(regex => new RegExp(regex, "i").test(user.userDescription ?? ""))) {
                return;
            }
        }

        if (config.socialLinkRegex) {
            if (!socialLinks.length) {
                return;
            }

            if (!config.socialLinkRegex.some(regex => socialLinks.some(link => new RegExp(regex, "i").test(link.outboundUrl)))) {
                return;
            }
        }

        if (config["~socialLinkRegex"] && socialLinks.length > 0) {
            if (config["~socialLinkRegex"].some(regex => socialLinks.some(link => new RegExp(regex, "i").test(link.outboundUrl)))) {
                return;
            }
        }

        if (config.flags) {
            if (!userDetails.flags || !config.flags.every(flag => userDetails.flags?.includes(flag))) {
                return;
            }
        }

        if (config["~flags"]) {
            if (userDetails.flags && config["~flags"].some(flag => userDetails.flags?.includes(flag))) {
                return;
            }
        }

        return config;
    });

    let appealOutcome: AppealOutcome;
    if (matchedAppealConfig) {
        console.log(`Appeals: Found an appeal for user ${username}: ${matchedAppealConfig.name}`);
        appealOutcome = {
            name: matchedAppealConfig.name,
            newStatus: matchedAppealConfig.setStatus,
            privateReply: matchedAppealConfig.privateReply,
            reply: matchedAppealConfig.reply,
            archive: matchedAppealConfig.archive,
            mute: matchedAppealConfig.mute,
        };
    } else {
        console.log(`Appeals: No specific appeal config matched for user ${username}, using default reply.`);
        appealOutcome = defaultAppealOutcome;
    }

    if (appealOutcome.newStatus && userDetails.trackingPostId) {
        const flairTemplateId = Object.values(UserStatus).includes(appealOutcome.newStatus as UserStatus) ? statusToFlair[appealOutcome.newStatus as UserStatus] : undefined;
        const flairText = flairTemplateId === undefined ? appealOutcome.newStatus : undefined;
        await context.reddit.setPostFlair({
            postId: userDetails.trackingPostId,
            flairTemplateId,
            text: flairText,
            subredditName: CONTROL_SUBREDDIT,
        });
    }

    if (appealOutcome.privateReply) {
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: formatPlaceholders(appealOutcome.privateReply, userDetails),
            isInternal: true,
        });
    }

    if (appealOutcome.reply) {
        let replyMessage = `${formatPlaceholders(appealOutcome.reply, userDetails)}\n\n`;
        if (appealOutcome.mute) {
            replyMessage += "*This is an automated response.*";
        } else if (matchedAppealConfig) {
            replyMessage += "*This is an automated response, but replies will be read. Please allow 24 hours for a response.*";
        } else {
            replyMessage += "*This is an automated response. Please allow 24 hours for a response but we will aim to respond sooner.*";
        }

        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: replyMessage,
            isInternal: false,
            isAuthorHidden: true,
        });
    }

    if (appealOutcome.mute === 3 || appealOutcome.mute === 7 || appealOutcome.mute === 28) {
        let muteDuration: 72 | 168 | 672 | undefined;
        switch (appealOutcome.mute) {
            case 3:
                muteDuration = 72;
                break;
            case 7:
                muteDuration = 168;
                break;
            case 28:
                muteDuration = 672;
                break;
        }

        await context.reddit.modMail.muteConversation({
            conversationId: modmail.conversationId,
            numHours: muteDuration,
        });
    }

    if (appealOutcome.archive) {
        await context.reddit.modMail.archiveConversation(modmail.conversationId);
    }
}
