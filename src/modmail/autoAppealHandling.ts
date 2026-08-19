/* eslint-disable @stylistic/quote-props */
import { Comment, ModNote, Post, TriggerContext, UserSocialLink } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { BIO_TEXT_STORE, SOCIAL_LINKS_STORE, UserDetails } from "../dataStore.js";
import { getControlSubSettings } from "../settings.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { parseAllDocuments } from "yaml";
import _ from "lodash";
import json2md from "json2md";
import { normaliseHitReason, sendMessageToWebhook } from "../utility.js";
import { ModmailMessage } from "./modmail.js";
import { evaluateUserAccount, EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { getUserExtended } from "@fsvreddit/fsv-devvit-helpers";
import { statusToFlair } from "../postCreation.js";
import { addMinutes, addSeconds, addWeeks, differenceInMonths, format, getYear, subMonths } from "date-fns";
import { getPossibleSetStatusValues } from "./controlSubModmail.js";
import { getUserSocialLinks } from "devvit-helpers";
import { sendMessageOnDelay } from "./delayedSend.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { AppealConfigWithCompiledRegexes, AppealRegexConfig, type CompiledAppealRegexes, compileAppealConfigs, getAppealConfigRegexIssues } from "./appealConfigRegex.js";
import { UserFlag, UserStatus } from "../types.js";
import { recordAppealHandled } from "../statistics/appealStatistics.js";

const APPEAL_CONFIG_WIKI_PAGE = "appeal-config";
const APPEAL_CONFIG_REDIS_KEY = "AppealConfig";

interface AppealConfig extends AppealRegexConfig {
    isHackedAppealConfig?: boolean;
    priority?: number;
    submitter?: string;
    operator?: string;
    banDateFrom?: string;
    banDateTo?: string;
    flags?: UserFlag[];
    "~flags"?: UserFlag[];
    hasMoreThanOneCommentOnPost?: boolean;
    hasNSFWPosts?: boolean;
    setStatus?: string;
    privateReply?: string;
    reply?: string;
    replyDelay?: {
        minMinutes: number;
        maxMinutes: number;
    };
    archive?: boolean;
    mute?: number;
    highlight?: boolean;
    respondToFurtherMessages?: boolean;
}

export type CompiledAppealConfig = AppealConfigWithCompiledRegexes<AppealConfig>;

const acceptableMuteDurations = [3, 7, 28];

const dateRegex = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/;

const appealConfigSchema: JSONSchemaType<AppealConfig[]> = {
    type: "array",
    items: {
        type: "object",
        properties: {
            name: { type: "string" },
            isHackedAppealConfig: { type: "boolean", nullable: true },
            priority: { type: "number", nullable: true },
            submitter: { type: "string", nullable: true },
            operator: { type: "string", nullable: true },
            usernameRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~usernameRegex": { type: "array", items: { type: "string" }, nullable: true },
            messageBodyRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~messageBodyRegex": { type: "array", items: { type: "string" }, nullable: true },
            banDateFrom: { type: "string", pattern: dateRegex.source, nullable: true },
            banDateTo: { type: "string", pattern: dateRegex.source, nullable: true },
            evaluatorNameRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~evaluatorNameRegex": { type: "array", items: { type: "string" }, nullable: true },
            evaluatorHitReasonRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~evaluatorHitReasonRegex": { type: "array", items: { type: "string" }, nullable: true },
            evaluatorDetailRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~evaluatorDetailRegex": { type: "array", items: { type: "string" }, nullable: true },
            currentEvaluatorNameRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~currentEvaluatorNameRegex": { type: "array", items: { type: "string" }, nullable: true },
            currentEvaluatorHitReasonRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~currentEvaluatorHitReasonRegex": { type: "array", items: { type: "string" }, nullable: true },
            currentEvaluatorDetailRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~currentEvaluatorDetailRegex": { type: "array", items: { type: "string" }, nullable: true },
            bioRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~bioRegex": { type: "array", items: { type: "string" }, nullable: true },
            originalBioRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~originalBioRegex": { type: "array", items: { type: "string" }, nullable: true },
            socialLinkRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~socialLinkRegex": { type: "array", items: { type: "string" }, nullable: true },
            originalSocialLinkRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~originalSocialLinkRegex": { type: "array", items: { type: "string" }, nullable: true },
            flags: { type: "array", items: { type: "string", enum: Object.values(UserFlag) }, nullable: true },
            "~flags": { type: "array", items: { type: "string", enum: Object.values(UserFlag) }, nullable: true },
            modNoteTextRegex: { type: "array", items: { type: "string" }, nullable: true },
            "~modNoteTextRegex": { type: "array", items: { type: "string" }, nullable: true },
            hasMoreThanOneCommentOnPost: { type: "boolean", nullable: true },
            hasNSFWPosts: { type: "boolean", nullable: true },
            setStatus: { type: "string", enum: getPossibleSetStatusValues(), nullable: true },
            privateReply: { type: "string", nullable: true },
            reply: { type: "string", nullable: true },
            replyDelay: {
                type: "object",
                properties: {
                    minMinutes: { type: "number", minimum: 0, maximum: 60 },
                    maxMinutes: { type: "number", minimum: 0, maximum: 1440 },
                },
                required: ["minMinutes", "maxMinutes"],
                additionalProperties: false,
                nullable: true,
            },
            archive: { type: "boolean", nullable: true },
            mute: { type: "number", enum: acceptableMuteDurations, nullable: true },
            highlight: { type: "boolean", nullable: true },
            respondToFurtherMessages: { type: "boolean", nullable: true },
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
    replyDelay?: {
        minMinutes: number;
        maxMinutes: number;
    };
    archive?: boolean;
    mute?: number;
    highlight?: boolean;
    respondToFurtherMessages?: boolean;
}

const defaultAppealOutcome: AppealOutcome = {
    name: "Default Appeal Reply",
    reply: `Your classification appeal has been received and will be reviewed by a moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.

If Bot Bouncer has banned you from more than one subreddit, you don't need to appeal separately.`,
};

function regexesMatchText (regexes: RegExp[] | undefined, text: string | undefined): boolean {
    if (!regexes?.length || text === undefined) {
        return false;
    }

    return regexes.some(regex => regex.test(text));
}

function evaluationHitReasonMatches (evaluationResult: EvaluationResult, regexes: RegExp[] | undefined): boolean {
    if (!regexes?.length || !evaluationResult.hitReason) {
        return false;
    }

    return regexesMatchText(regexes, normaliseHitReason(evaluationResult.hitReason).reason);
}

function evaluationDetailMatches (evaluationResult: EvaluationResult, regexes: RegExp[] | undefined): boolean {
    if (!regexes?.length || !evaluationResult.hitReason || typeof evaluationResult.hitReason === "string") {
        return false;
    }

    return evaluationResult.hitReason.details.some(detail => regexesMatchText(regexes, detail.value));
}

export function evaluationResultMatchesRegexes (
    evaluationResult: EvaluationResult,
    evaluatorNameRegex?: RegExp[],
    evaluatorHitReasonRegex?: RegExp[],
    evaluatorDetailRegex?: RegExp[],
): boolean {
    if (evaluatorNameRegex !== undefined && !regexesMatchText(evaluatorNameRegex, evaluationResult.botName)) {
        return false;
    }

    if (evaluatorHitReasonRegex !== undefined && !evaluationHitReasonMatches(evaluationResult, evaluatorHitReasonRegex)) {
        return false;
    }

    if (evaluatorDetailRegex !== undefined && !evaluationDetailMatches(evaluationResult, evaluatorDetailRegex)) {
        return false;
    }

    return true;
}

function evaluationResultsContainMatch (
    evaluationResults: EvaluationResult[],
    evaluatorNameRegex?: RegExp[],
    evaluatorHitReasonRegex?: RegExp[],
    evaluatorDetailRegex?: RegExp[],
): boolean {
    return evaluationResults.some(evaluationResult => evaluationResultMatchesRegexes(
        evaluationResult,
        evaluatorNameRegex,
        evaluatorHitReasonRegex,
        evaluatorDetailRegex,
    ));
}

export interface NegatedAppealRegexContext {
    messageBody: string;
    initialEvaluationResults: EvaluationResult[];
    currentEvaluationResults: EvaluationResult[];
    originalBio: string | undefined;
    originalSocialLinks: { outboundUrl: string }[];
}

export function negatedAppealRegexesExcludeConfig (
    regexes: CompiledAppealRegexes,
    context: NegatedAppealRegexContext,
): boolean {
    if (regexes["~messageBodyRegex"]?.some(regex => regex.test(context.messageBody))) {
        return true;
    }

    const hasInitialEvaluatorNegation =
        regexes["~evaluatorNameRegex"] !== undefined ||
        regexes["~evaluatorHitReasonRegex"] !== undefined;

    if (
        hasInitialEvaluatorNegation &&
        evaluationResultsContainMatch(
            context.initialEvaluationResults,
            regexes["~evaluatorNameRegex"],
            regexes["~evaluatorHitReasonRegex"],
            regexes["~evaluatorDetailRegex"],
        )
    ) {
        return true;
    }

    const hasCurrentEvaluatorNegation =
        regexes["~currentEvaluatorNameRegex"] !== undefined ||
        regexes["~currentEvaluatorHitReasonRegex"] !== undefined;

    if (
        hasCurrentEvaluatorNegation &&
        evaluationResultsContainMatch(
            context.currentEvaluationResults,
            regexes["~currentEvaluatorNameRegex"],
            regexes["~currentEvaluatorHitReasonRegex"],
            regexes["~currentEvaluatorDetailRegex"],
        )
    ) {
        return true;
    }

    if (
        context.originalBio &&
        regexes["~originalBioRegex"]?.some(regex => regex.test(context.originalBio ?? ""))
    ) {
        return true;
    }

    if (
        regexes["~originalSocialLinkRegex"]?.some(regex => context.originalSocialLinks.some(link => regex.test(link.outboundUrl)))
    ) {
        return true;
    }

    return false;
}

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
    const wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, APPEAL_CONFIG_WIKI_PAGE, {});
    const lastAppealConfigRevision = await context.redis.get(appealConfigRevisionKey);
    if (wikiPage.revisionId === lastAppealConfigRevision) {
        // The saved config is up-to-date with the latest revision
        return;
    }

    let substitutions: Record<string, string | string[]>;
    try {
        substitutions = getSubstitutions(wikiPage.content);
    } catch {
        console.error("Failed to parse substitutions from the appeal config wiki page.");

        await context.reddit.sendPrivateMessage({
            to: username,
            subject: "Error in appeal configuration",
            text: json2md([
                { p: "Unable to parse YAML on the appeal configuration page." },
                { p: "Please ensure the page is formatted correctly." },
            ]),
        });

        const webhookUrl = await getControlSubSettings(context).then(s => s.monitoringWebhook);
        if (webhookUrl) {
            await sendMessageToWebhook(webhookUrl, json2md([
                { p: `There was an error in the appeal configuration, last updated by ${username}` },
                { p: "Last known good values will be used until this is corrected." },
                { p: "The YAML on the appeal configuration page could not be parsed." },
            ]));
        }

        return;
    }

    let pageToParse = wikiPage.content;
    for (const [key, value] of Object.entries(substitutions)) {
        const valueToSubstitute = JSON.stringify(value);
        pageToParse = pageToParse.replaceAll(`{{${key}}}`, valueToSubstitute);
    }

    const documents = parseAllDocuments(pageToParse);

    const parsedConfigs = _.compact(documents.map(doc => doc.toJSON() as AppealConfig)).filter(item => item.name !== "substitutions");

    const ajv = new Ajv.default({
        coerceTypes: "array",
    });

    const validate = ajv.compile(appealConfigSchema);

    const issues: string[] = [];

    if (!validate(parsedConfigs)) {
        issues.push(ajv.errorsText(validate.errors));
    }

    issues.push(...getAppealConfigRegexIssues(parsedConfigs));

    let compiledConfigs: CompiledAppealConfig[] | undefined;
    if (issues.length === 0) {
        try {
            compiledConfigs = compileAppealConfigs(parsedConfigs);
        } catch (error) {
            issues.push(`Unable to compile appeal config: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (issues.length === 0 && compiledConfigs) {
        // Save the valid config to Redis and update the in-memory compiled cache.
        const configData = JSON.stringify(parsedConfigs);
        await context.redis.set(APPEAL_CONFIG_REDIS_KEY, configData);
        await context.redis.set(appealConfigRevisionKey, wikiPage.revisionId);
        console.log(`Appeal config updated to revision ${wikiPage.revisionId}`);
        return;
    }

    console.error("Invalid appeal config:", issues);

    await context.reddit.sendPrivateMessage({
        to: username,
        subject: "Error in appeal configuration",
        text: json2md([
            { p: "There was an error in your appeal configuration:" },
            { ul: issues },
        ]),
    });

    const webhookUrl = await getControlSubSettings(context).then(s => s.monitoringWebhook);
    if (webhookUrl) {
        await sendMessageToWebhook(webhookUrl, json2md([
            { p: `There was an error in the appeal configuration, last updated by ${username}:` },
            { p: "Last known good values will be used until this is corrected." },
            { ul: issues },
        ]));
    }
}

export function sortedAppealConfigs (configs: CompiledAppealConfig[]): CompiledAppealConfig[] {
    // Sort configs by priority (higher priority first), and then preserve the original order for configs with the same priority.
    return [...configs].sort((a, b) => {
        const priorityA = a.priority ?? 0;
        const priorityB = b.priority ?? 0;

        if (priorityA !== priorityB) {
            return priorityB - priorityA; // Higher priority first
        }

        return 0; // Preserve original order for same priority
    });
}

export async function getAppealConfig (context: TriggerContext): Promise<CompiledAppealConfig[]> {
    const configData = await context.redis.get(APPEAL_CONFIG_REDIS_KEY);
    if (!configData) {
        console.warn("No appeal config found in Redis. Returning empty config.");
        return [];
    }

    try {
        const configs = JSON.parse(configData) as AppealConfig[];
        return sortedAppealConfigs(compileAppealConfigs(configs));
    } catch (error) {
        console.error("Unable to compile stored appeal config; continuing with the last known good in-memory config:", error instanceof Error ? error.message : String(error));
        return [];
    }
}

function formatPlaceholders (input: string, userDetails: UserDetails): string {
    let output = input;
    let dateFormat: string;
    const date = new Date(userDetails.reportedAt ?? userDetails.lastUpdate);
    if (getYear(new Date()) !== getYear(date) && differenceInMonths(new Date(), date) > 6) {
        dateFormat = "MMMM do, yyyy";
    } else {
        dateFormat = "MMMM do";
    }

    output = output.replaceAll("{{classificationdate}}", format(new Date(userDetails.reportedAt ?? userDetails.lastUpdate), dateFormat));
    return output;
}

export enum AppealOutcomeType {
    Skipped = "skipped",
    Neutral = "neutral",
    StatusChanged = "statusChanged",
    AppealGranted = "appealGranted",
}

function isAppealGrantStatus (status: string | undefined): boolean {
    return status === UserStatus.Organic
        || status === UserFlag.HackedAndRecovered
        || status === UserFlag.Scammed
        || status === UserFlag.FutureNSFW;
}

export async function getMatchedAppealConfig (username: string, userDetails: UserDetails, appealConfig: CompiledAppealConfig[], modmailMessage: string | undefined, context: TriggerContext, debug = false) {
    const initialAccountEvaluationResults = await getAccountInitialEvaluationResults(username, context);

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (initialAccountEvaluationResults.length === 0 && appealConfig.every(config => config.evaluatorDetailRegex || config.evaluatorHitReasonRegex || config.evaluatorNameRegex)) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const user = appealConfig.some(config => config.bioRegex || config["~bioRegex"]) ? await getUserExtended(username, context) : undefined;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const socialLinks = appealConfig.some(config => config.socialLinkRegex || config["~socialLinkRegex"]) ? await getUserSocialLinks(username, context.metadata) : [];

    const originalBio = await context.redis.hGet(BIO_TEXT_STORE, username);
    const originalSocialLinks = await context.redis.hGet(SOCIAL_LINKS_STORE, username)
        .then(data => data ? JSON.parse(data) as UserSocialLink[] : []);

    let modNotes: ModNote[] = [];

    if (appealConfig.some(config => config.modNoteTextRegex?.length ?? config["~modNoteTextRegex"]?.length)) {
        modNotes = await context.reddit.getModNotes({
            subreddit: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
            user: username,
            filter: "NOTE",
        }).all().then(items => items.filter(item => item.userNote?.note && item.operator.name !== username));
    }

    let currentEvaluationResults: EvaluationResult[] = [];

    if (appealConfig.some(config => [
        config.compiledRegexes.currentEvaluatorHitReasonRegex,
        config.compiledRegexes.currentEvaluatorNameRegex,
        config.compiledRegexes["~currentEvaluatorHitReasonRegex"],
        config.compiledRegexes["~currentEvaluatorNameRegex"],
    ].some(regexes => (regexes?.length ?? 0) > 0))) {
        currentEvaluationResults = await evaluateUserAccount({
            username,
            variables: await getEvaluatorVariables(context),
        }, context, true);
    }

    let history: (Post | Comment)[] = [];

    if (appealConfig.some(config => config.hasMoreThanOneCommentOnPost !== undefined || config.hasNSFWPosts !== undefined)) {
        history = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
            sort: "new",
        }).all();
    }

    const matchedAppealConfig = appealConfig.find((config) => {
        try {
            const regexes = config.compiledRegexes;

            if (negatedAppealRegexesExcludeConfig(regexes, {
                messageBody: modmailMessage ?? "",
                initialEvaluationResults: initialAccountEvaluationResults,
                currentEvaluationResults,
                originalBio,
                originalSocialLinks,
            })) {
                return;
            }

            if (regexes.usernameRegex && !regexes.usernameRegex.some(regex => regex.test(username))) {
                if (debug) {
                    console.log(`Appeals: usernameRegex did not match for ${config.name}`);
                }
                return;
            }

            if (regexes["~usernameRegex"]?.some(regex => regex.test(username))) {
                if (debug) {
                    console.log(`Appeals: ~usernameRegex matched username on ${config.name}`);
                }
                return;
            }

            if (regexes.messageBodyRegex && !regexes.messageBodyRegex.some(regex => regex.test(modmailMessage ?? ""))) {
                if (debug) {
                    console.log(`Appeals: messageBodyRegex did not match for ${config.name}`);
                }
                return;
            }

            if (config.banDateFrom && (userDetails.reportedAt ?? userDetails.lastUpdate) < new Date(config.banDateFrom).getTime()) {
                if (debug) {
                    console.log(`Appeals: banDateFrom did not match for ${config.name}`);
                }
                return;
            }

            if (config.banDateTo && (userDetails.reportedAt ?? userDetails.lastUpdate) > new Date(config.banDateTo).getTime()) {
                if (debug) {
                    console.log(`Appeals: banDateTo did not match for ${config.name}`);
                }
                return;
            }

            if (config.submitter && config.submitter !== userDetails.submitter) {
                if (debug) {
                    console.log(`Appeals: submitter did not match for ${config.name}`);
                }
                return;
            }

            if (config.operator && config.operator !== userDetails.operator) {
                if (debug) {
                    console.log(`Appeals: operator did not match for ${config.name}`);
                }
                return;
            }

            if (regexes.evaluatorNameRegex !== undefined || regexes.evaluatorHitReasonRegex !== undefined) {
                if (!evaluationResultsContainMatch(
                    initialAccountEvaluationResults,
                    regexes.evaluatorNameRegex,
                    regexes.evaluatorHitReasonRegex,
                    regexes.evaluatorDetailRegex,
                )) {
                    return;
                }
            }

            if (regexes.currentEvaluatorNameRegex !== undefined || regexes.currentEvaluatorHitReasonRegex !== undefined) {
                if (!evaluationResultsContainMatch(
                    currentEvaluationResults,
                    regexes.currentEvaluatorNameRegex,
                    regexes.currentEvaluatorHitReasonRegex,
                    regexes.currentEvaluatorDetailRegex,
                )) {
                    return;
                }
            }

            if (config.bioRegex) {
                if (!user?.userDescription) {
                    if (debug) {
                        console.log(`Appeals: bioRegex cannot match due to lack of current bio for ${config.name}`);
                    }
                    return;
                }

                if (!regexes.bioRegex?.some(regex => regex.test(user.userDescription ?? ""))) {
                    if (debug) {
                        console.log(`Appeals: bioRegex did not match for ${config.name}`);
                    }
                    return;
                }
            }

            if (config["~bioRegex"] && user?.userDescription) {
                if (regexes["~bioRegex"]?.some(regex => regex.test(user.userDescription ?? ""))) {
                    if (debug) {
                        console.log(`Appeals: ~bioRegex matched current bio for ${config.name}`);
                    }
                    return;
                }
            }

            if (config.originalBioRegex) {
                if (!originalBio) {
                    if (debug) {
                        console.log(`Appeals: originalBioRegex cannot match, user has no original bio stored for ${config.name}`);
                    }
                    return;
                }

                if (!regexes.originalBioRegex?.some(regex => regex.test(originalBio))) {
                    if (debug) {
                        console.log(`Appeals: originalBioRegex did not match the user's original bio for ${config.name}`);
                    }
                    return;
                }
            }

            if (config.socialLinkRegex) {
                if (!socialLinks.length) {
                    if (debug) {
                        console.log(`Appeals: socialLinkRegex cannot match as user has no current links for ${config.name}`);
                    }
                    return;
                }

                if (!regexes.socialLinkRegex?.some(regex => socialLinks.some(link => regex.test(link.outboundUrl)))) {
                    if (debug) {
                        console.log(`Appeals: socialLinkRegex did not match for ${config.name}`);
                    }
                    return;
                }
            }

            if (config["~socialLinkRegex"] && socialLinks.length > 0) {
                if (regexes["~socialLinkRegex"]?.some(regex => socialLinks.some(link => regex.test(link.outboundUrl)))) {
                    if (debug) {
                        console.log(`Appeals: ~socialLinkRegex matched a current link for ${config.name}`);
                    }
                    return;
                }
            }

            if (config.originalSocialLinkRegex) {
                if (originalSocialLinks.length === 0) {
                    if (debug) {
                        console.log(`Appeals: originalSocialLinkRegex cannot match due to no original links for ${config.name}`);
                    }
                    return;
                }

                if (!regexes.originalSocialLinkRegex?.some(regex => originalSocialLinks.some(link => regex.test(link.outboundUrl)))) {
                    if (debug) {
                        console.log(`Appeals: originalSocialLinkRegex did not match an original link for ${config.name}`);
                    }
                    return;
                }
            }

            if (config.flags) {
                if (!userDetails.flags || !config.flags.every(flag => userDetails.flags?.includes(flag))) {
                    if (debug) {
                        console.log(`Appeals: flags did not match for ${config.name}`);
                    }
                    return;
                }
            }

            if (config["~flags"]) {
                if (userDetails.flags && config["~flags"].some(flag => userDetails.flags?.includes(flag))) {
                    if (debug) {
                        console.log(`Appeals: ~flags matched a current flag for ${config.name}`);
                    }
                    return;
                }
            }

            if (config.hasMoreThanOneCommentOnPost !== undefined) {
                const commentsPerPost = _.countBy(history.filter(item => "postId" in item).map(comment => comment.postId));
                const hasMoreThanOneCommentOnPost = Object.values(commentsPerPost).some(count => count > 1);

                if (config.hasMoreThanOneCommentOnPost !== hasMoreThanOneCommentOnPost) {
                    if (debug) {
                        console.log(`Appeals: user has more than one comment on post ${config.name}`);
                    }
                    return;
                }
            }

            if (config.hasNSFWPosts !== undefined) {
                const hasNSFWPosts = history.some(item => "nsfw" in item && item.nsfw && item.createdAt > subMonths(new Date(), 6));

                if (config.hasNSFWPosts !== hasNSFWPosts) {
                    if (debug) {
                        console.log(`Appeals: hasNSFWPosts failed as user has NSFW posts for ${config.name}`);
                    }
                    return;
                }
            }

            if (config.modNoteTextRegex) {
                if (!modNotes.some(modNote => regexes.modNoteTextRegex?.some(regex => regex.test(modNote.userNote?.note ?? "")))) {
                    if (debug) {
                        console.log(`Appeals: modNoteTextRegex did not match for ${config.name}`);
                    }
                    return;
                }
            }

            if (config["~modNoteTextRegex"]) {
                if (modNotes.some(modNote => regexes["~modNoteTextRegex"]?.some(regex => regex.test(modNote.userNote?.note ?? "")))) {
                    if (debug) {
                        console.log(`Appeals: ~modNoteTextRegex matched a mod note for ${config.name}`);
                    }
                    return;
                }
            }

            return config;
        } catch (error) {
            console.error(`Error processing appeal config ${config.name}:`, error instanceof Error ? error.message : String(error));
            return;
        }
    });

    return matchedAppealConfig;
}

export async function handleAppeal (modmail: ModmailMessage, userDetails: UserDetails, context: TriggerContext, recoveredOnly = false): Promise<AppealOutcomeType> {
    const username = modmail.participant;
    if (!username) {
        return AppealOutcomeType.Skipped;
    }

    let appealConfig = await getAppealConfig(context);
    if (recoveredOnly) {
        appealConfig = appealConfig.filter(config => config.isHackedAppealConfig && config.setStatus === UserFlag.HackedAndRecovered);
    }

    const matchedAppealConfig = await getMatchedAppealConfig(username, userDetails, appealConfig, modmail.bodyMarkdown, context);

    let appealOutcome: AppealOutcome;
    let appealOutcomeType: AppealOutcomeType = AppealOutcomeType.Neutral;

    if (matchedAppealConfig) {
        console.log(`Appeals: Found an appeal for user ${username}: ${matchedAppealConfig.name}`);
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: `Appeal matched config: ${matchedAppealConfig.name}`,
            isInternal: true,
        });

        appealOutcome = {
            name: matchedAppealConfig.name,
            newStatus: matchedAppealConfig.setStatus,
            privateReply: matchedAppealConfig.privateReply,
            reply: matchedAppealConfig.reply,
            replyDelay: matchedAppealConfig.replyDelay,
            archive: matchedAppealConfig.archive,
            mute: matchedAppealConfig.mute,
            highlight: matchedAppealConfig.highlight,
            respondToFurtherMessages: matchedAppealConfig.respondToFurtherMessages,
        };
    } else if (recoveredOnly) {
        return AppealOutcomeType.Skipped;
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

        appealOutcomeType = isAppealGrantStatus(appealOutcome.newStatus) ? AppealOutcomeType.AppealGranted : AppealOutcomeType.StatusChanged;
        if (appealOutcomeType === AppealOutcomeType.AppealGranted) {
            await recordAppealHandled(context.appSlug, context);
        }
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

        if (appealOutcome.replyDelay) {
            let sendAt: Date;
            if (appealOutcome.replyDelay.minMinutes >= appealOutcome.replyDelay.maxMinutes) {
                sendAt = addMinutes(new Date(), appealOutcome.replyDelay.minMinutes);
            } else {
                const delayMinutes = Math.floor(Math.random() * (appealOutcome.replyDelay.maxMinutes - appealOutcome.replyDelay.minMinutes + 1)) + appealOutcome.replyDelay.minMinutes;
                sendAt = addMinutes(new Date(), delayMinutes);
            }

            await sendMessageOnDelay(context, {
                conversationId: modmail.conversationId,
                message: replyMessage,
                archive: appealOutcome.archive,
                sendAt,
            });
        } else {
            if (appealOutcome.mute) {
                replyMessage += "*This is an automated response.*";
            } else if (matchedAppealConfig) {
                replyMessage += "*This is an automated response, but replies will be read. Please allow 24 hours for a response.*";
            } else {
                replyMessage += "*This is an automated response. Please allow 24 hours for a response but we will aim to respond sooner.*";
            }

            await sendMessageOnDelay(context, {
                conversationId: modmail.conversationId,
                message: replyMessage,
                archive: appealOutcome.archive,
                sendAt: addSeconds(new Date(), 20),
            });
        }
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

    if (appealOutcome.highlight) {
        await context.reddit.modMail.highlightConversation(modmail.conversationId);
    }

    if (appealOutcome.respondToFurtherMessages === true) {
        await setRespondToFurtherMessagesFlag(context, modmail.conversationId);
    }

    return appealOutcomeType;
}

function getRespondToFurtherMessagesKey (conversationId: string): string {
    return `RespondToFurtherMessages:${conversationId}`;
}

async function setRespondToFurtherMessagesFlag (context: TriggerContext, conversationId: string): Promise<void> {
    await context.redis.set(getRespondToFurtherMessagesKey(conversationId), "true", { expiration: addWeeks(new Date(), 4) });
}

export async function getRespondToFurtherMessagesFlag (context: TriggerContext, conversationId: string): Promise<boolean> {
    const value = await context.redis.get(getRespondToFurtherMessagesKey(conversationId));
    return value === "true";
}

export async function clearRespondToFurtherMessagesFlag (context: TriggerContext, conversationId: string): Promise<void> {
    await context.redis.del(getRespondToFurtherMessagesKey(conversationId));
}
