import { Comment, JobContext, JSONObject, Post, ScheduledJobEvent, TriggerContext, UserSocialLink } from "@devvit/public-api";
import { getUserExtended } from "@fsvreddit/fsv-devvit-helpers";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { getUserSocialLinks } from "devvit-helpers";
import json2md from "json2md";
import pluralize from "pluralize";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { getInitialAccountProperties, getUserStatus, setUserStatus, UserDetails, UserFlag, UserStatus } from "../dataStore.js";
import { EvaluationResult, evaluateUserAccount, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { statusToFlair } from "../postCreation.js";
import { getEvaluatorVariables } from "./evaluatorVariables.js";

const HACKED_PROFILE_RECOVERY_REVIEW_QUEUE_KEY = "hackedProfileRecoveryReviewQueue";
const HACKED_PROFILE_RECOVERY_REVIEW_STATE_KEY = "hackedProfileRecoveryReviewState";
const HACKED_PROFILE_RECOVERY_REVIEW_BACKOFF_DAYS = [7, 14, 30, 60];

const PROFILE_TAKEOVER_EVALUATOR_REGEX = /\b(?:bio|display|profile|social|link|defined handle|defined handles|promotion|promotional|adult|nsfw|onlyfans|fansly|snapchat|telegram|whatsapp|linktree|beacons|allmylinks)\b/iu;
const FRESH_PROMOTIONAL_ACTIVITY_REGEX = /\b(?:dm|message me|subscribe|follow me|link in bio|check my profile|onlyfans|fansly|snapchat|telegram|whatsapp|linktree|beacons\.ai|allmylinks)\b/iu;

interface HackedProfileRecoveryReviewQueueItem {
    username: string;
    attempts: number;
    queuedAt: number;
    lastCheckedAt?: number;
}

interface InitialProfileProperties {
    bioText?: string;
    displayName?: string;
    socialLinks: UserSocialLink[];
}

export interface HackedProfileRecoveryDecision {
    recovered: boolean;
    revertedFields: string[];
    blockedReasons: string[];
    currentEvaluationResults: EvaluationResult[];
    freshPromotionalActivity: boolean;
}

function normalizeProfileText (value: string | undefined): string {
    return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function normalizeDisplayName (username: string, value: string | undefined): string {
    const normalized = normalizeProfileText(value);
    if (normalized === username.toLowerCase() || normalized === `u_${username.toLowerCase()}`) {
        return "";
    }

    return normalized;
}

function normalizeSocialLink (link: UserSocialLink): string {
    return link.outboundUrl.trim().replace(/\/$/u, "").toLowerCase();
}

function getStoredProfileFields (initialProperties: InitialProfileProperties): string[] {
    const fields: string[] = [];
    if (normalizeProfileText(initialProperties.bioText).length > 0) {
        fields.push("bio");
    }

    if (normalizeProfileText(initialProperties.displayName).length > 0) {
        fields.push("display name");
    }

    if (initialProperties.socialLinks.length > 0) {
        fields.push("social links");
    }

    return fields;
}

function socialLinksReverted (initialLinks: UserSocialLink[], currentLinks: UserSocialLink[]): boolean {
    if (initialLinks.length === 0) {
        return false;
    }

    const currentUrls = new Set(currentLinks.map(normalizeSocialLink));
    return initialLinks.every(link => !currentUrls.has(normalizeSocialLink(link)));
}

function getHitReasonText (result: EvaluationResult): string {
    if (!result.hitReason) {
        return "";
    }

    if (typeof result.hitReason === "string") {
        return result.hitReason;
    }

    return [
        result.hitReason.reason,
        ...result.hitReason.details.map(detail => `${detail.key}: ${detail.value}`),
    ].join("\n");
}

function getEvaluationResultText (result: EvaluationResult): string {
    return `${result.botName}\n${getHitReasonText(result)}`;
}

function isProfileTakeoverEvaluationResult (result: EvaluationResult): boolean {
    return PROFILE_TAKEOVER_EVALUATOR_REGEX.test(getEvaluationResultText(result));
}

function isStrongProfileTakeoverEvaluationResult (result: EvaluationResult): boolean {
    return result.canAutoBan && result.metThreshold && isProfileTakeoverEvaluationResult(result);
}

async function isLikelyHackedProfileBan (username: string, context: TriggerContext): Promise<boolean> {
    const initialEvaluationResults = await getAccountInitialEvaluationResults(username, context);
    if (!initialEvaluationResults.some(isProfileTakeoverEvaluationResult)) {
        return false;
    }

    const initialProperties = await getInitialAccountProperties(username, context);
    return getStoredProfileFields(initialProperties).length >= 2;
}

function getItemText (item: Post | Comment): string {
    if (item instanceof Comment) {
        return item.body;
    }

    return `${item.title}\n${item.body ?? ""}`;
}

async function userHasFreshPromotionalActivity (username: string, since: number, context: TriggerContext): Promise<boolean> {
    let history: (Post | Comment)[];
    try {
        history = await context.reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            limit: 100,
        }).all();
    } catch {
        return false;
    }

    return history.some(item => item.createdAt.getTime() > since && FRESH_PROMOTIONAL_ACTIVITY_REGEX.test(getItemText(item)));
}

function getNextRunAt (attempts: number): Date | undefined {
    switch (attempts) {
        case 0:
            return addDays(new Date(), HACKED_PROFILE_RECOVERY_REVIEW_BACKOFF_DAYS[0]);
        case 1:
            return addDays(new Date(), HACKED_PROFILE_RECOVERY_REVIEW_BACKOFF_DAYS[1]);
        case 2:
            return addDays(new Date(), HACKED_PROFILE_RECOVERY_REVIEW_BACKOFF_DAYS[2]);
        case 3:
            return addDays(new Date(), HACKED_PROFILE_RECOVERY_REVIEW_BACKOFF_DAYS[3]);
        default:
            return undefined;
    }
}
async function getQueueItem (username: string, context: TriggerContext): Promise<HackedProfileRecoveryReviewQueueItem | undefined> {
    const value = await context.redis.hGet(HACKED_PROFILE_RECOVERY_REVIEW_STATE_KEY, username);
    if (!value) {
        return undefined;
    }

    return JSON.parse(value) as HackedProfileRecoveryReviewQueueItem;
}

async function saveQueueItem (item: HackedProfileRecoveryReviewQueueItem, runAt: Date, context: TriggerContext): Promise<void> {
    await context.redis.hSet(HACKED_PROFILE_RECOVERY_REVIEW_STATE_KEY, { [item.username]: JSON.stringify(item) });
    await context.redis.zAdd(HACKED_PROFILE_RECOVERY_REVIEW_QUEUE_KEY, { member: item.username, score: runAt.getTime() });
}

async function removeQueueItem (username: string, context: TriggerContext): Promise<void> {
    await Promise.all([
        context.redis.hDel(HACKED_PROFILE_RECOVERY_REVIEW_STATE_KEY, [username]),
        context.redis.zRem(HACKED_PROFILE_RECOVERY_REVIEW_QUEUE_KEY, [username]),
    ]);
}

export async function queueHackedProfileRecoveryReviewForBan (username: string, context: TriggerContext): Promise<void> {
    const currentStatus = await getUserStatus(username, context);
    if (currentStatus?.userStatus !== UserStatus.Banned) {
        await removeQueueItem(username, context);
        return;
    }

    if (!await isLikelyHackedProfileBan(username, context)) {
        await removeQueueItem(username, context);
        return;
    }

    const existingItem = await getQueueItem(username, context);
    if (existingItem) {
        return;
    }

    const item: HackedProfileRecoveryReviewQueueItem = {
        username,
        attempts: 0,
        queuedAt: Date.now(),
    };

    const runAt = getNextRunAt(item.attempts);
    if (!runAt) {
        return;
    }

    await saveQueueItem(item, runAt, context);
    console.log(`HackedProfileRecoveryReview: Queued ${username} for first review on ${runAt.toISOString()}`);
}

export async function getHackedProfileRecoveryDecision (username: string, userDetails: UserDetails | undefined, context: TriggerContext): Promise<HackedProfileRecoveryDecision> {
    const blockedReasons: string[] = [];
    const currentStatus = userDetails ?? await getUserStatus(username, context);
    const currentEvaluationResults: EvaluationResult[] = [];

    if (currentStatus?.userStatus !== UserStatus.Banned) {
        blockedReasons.push("User is not currently banned.");
        return {
            recovered: false,
            revertedFields: [],
            blockedReasons,
            currentEvaluationResults,
            freshPromotionalActivity: false,
        };
    }

    if (!await isLikelyHackedProfileBan(username, context)) {
        blockedReasons.push("Initial evaluation did not look like a profile takeover ban.");
    }

    const initialProperties = await getInitialAccountProperties(username, context);
    const storedFields = getStoredProfileFields(initialProperties);
    if (storedFields.length < 2) {
        blockedReasons.push("Fewer than two initial profile fields were stored.");
    }

    const user = await getUserExtended(username, context);
    if (!user) {
        blockedReasons.push("Could not fetch current user profile.");
        return {
            recovered: false,
            revertedFields: [],
            blockedReasons,
            currentEvaluationResults,
            freshPromotionalActivity: false,
        };
    }

    const currentSocialLinks = await getUserSocialLinks(username, context.metadata);
    const revertedFields: string[] = [];

    if (normalizeProfileText(initialProperties.bioText).length > 0 && normalizeProfileText(initialProperties.bioText) !== normalizeProfileText(user.userDescription)) {
        revertedFields.push("bio");
    }

    if (normalizeProfileText(initialProperties.displayName).length > 0 && normalizeProfileText(initialProperties.displayName) !== normalizeDisplayName(username, user.displayName)) {
        revertedFields.push("display name");
    }

    if (socialLinksReverted(initialProperties.socialLinks, currentSocialLinks)) {
        revertedFields.push("social links");
    }

    if (revertedFields.length < 2) {
        blockedReasons.push("Fewer than two profile fields have reverted from the stored initial takeover state.");
    }

    const variables = await getEvaluatorVariables(context);
    currentEvaluationResults.push(...await evaluateUserAccount({ username, variables }, context));
    if (currentEvaluationResults.some(isStrongProfileTakeoverEvaluationResult)) {
        blockedReasons.push("User still has a strong current hacked/profile-promotional evaluator hit.");
    }

    const freshPromotionalActivity = await userHasFreshPromotionalActivity(username, currentStatus.reportedAt ?? currentStatus.lastUpdate, context);
    if (freshPromotionalActivity) {
        blockedReasons.push("User has fresh promotional activity after the original ban.");
    }

    return {
        recovered: blockedReasons.length === 0,
        revertedFields,
        blockedReasons,
        currentEvaluationResults,
        freshPromotionalActivity,
    };
}

function markdownToText (markdown: json2md.DataObject[], limit = 5000): string[] {
    const text = json2md(markdown);
    if (text.length < limit) {
        return [text];
    }

    const chunks: string[] = [];
    let workingChunk = "";
    for (const line of text.split("\n")) {
        if (workingChunk.length + line.length + 1 > limit) {
            chunks.push(workingChunk);
            workingChunk = "";
        }
        workingChunk += `${line}\n`;
    }

    if (workingChunk.length > 0) {
        chunks.push(workingChunk);
    }

    return chunks;
}

async function sendRecoveryModmail (username: string, decision: HackedProfileRecoveryDecision, context: JobContext): Promise<void> {
    const strongHitCount = decision.currentEvaluationResults.filter(isStrongProfileTakeoverEvaluationResult).length;
    const message: json2md.DataObject[] = [
        { p: `User ${username} has been marked Organic with the HackedAndRecovered flag after scheduled recovery review.` },
        {
            ul: [
                `Reverted profile fields: ${decision.revertedFields.join(", ")}`,
                `Strong current hacked/profile-promotional evaluator hits: ${strongHitCount}`,
                `Fresh promotional activity found: ${decision.freshPromotionalActivity ? "yes" : "no"}`,
            ],
        },
        { hr: "" },
    ];

    message.push(...await getSummaryForUser(username, "modmail", context));

    const modmailStrings = markdownToText(message);
    const firstString = modmailStrings.shift();
    if (!firstString) {
        console.error(`HackedProfileRecoveryReview: No content to send in modmail for ${username}`);
        return;
    }

    const newConversationId = await context.reddit.modMail.createModInboxConversation({
        subredditId: context.subredditId,
        subject: `Hacked Profile Recovered: ${username}`,
        bodyMarkdown: firstString,
    });

    for (const string of modmailStrings) {
        await context.reddit.modMail.reply({
            body: string,
            conversationId: newConversationId,
            isInternal: true,
        });
    }
}

async function markUserRecovered (username: string, currentStatus: UserDetails, decision: HackedProfileRecoveryDecision, context: JobContext): Promise<void> {
    const flags = new Set(currentStatus.flags ?? []);
    flags.add(UserFlag.HackedAndRecovered);

    const updatedStatus: UserDetails = {
        ...currentStatus,
        userStatus: UserStatus.Organic,
        operator: context.appSlug,
        lastUpdate: Date.now(),
        flags: Array.from(flags),
    };

    await setUserStatus(username, updatedStatus, context);

    await context.redis.set(`ignoreflairchangeForPost:${currentStatus.trackingPostId}`, "true", { expiration: addMinutes(new Date(), 1) });
    await context.reddit.setPostFlair({
        postId: currentStatus.trackingPostId,
        subredditName: CONTROL_SUBREDDIT,
        flairTemplateId: statusToFlair[UserStatus.Organic],
    });

    await sendRecoveryModmail(username, decision, context);
}

async function reviewHackedProfileRecovery (username: string, context: JobContext): Promise<void> {
    const currentStatus = await getUserStatus(username, context);
    if (currentStatus?.userStatus !== UserStatus.Banned) {
        await removeQueueItem(username, context);
        return;
    }

    const decision = await getHackedProfileRecoveryDecision(username, currentStatus, context);
    if (decision.recovered) {
        await markUserRecovered(username, currentStatus, decision, context);
        await removeQueueItem(username, context);
        return;
    }

    const queueItem = await getQueueItem(username, context) ?? {
        username,
        attempts: 0,
        queuedAt: Date.now(),
    };

    queueItem.attempts += 1;
    queueItem.lastCheckedAt = Date.now();

    const nextRunAt = getNextRunAt(queueItem.attempts);
    if (!nextRunAt) {
        console.log(`HackedProfileRecoveryReview: Removing ${username} after ${queueItem.attempts} unsuccessful ${pluralize("review", queueItem.attempts)}.`);
        await removeQueueItem(username, context);
        return;
    }

    await saveQueueItem(queueItem, nextRunAt, context);
    console.log(`HackedProfileRecoveryReview: ${username} not recovered yet; next review scheduled for ${nextRunAt.toISOString()}. Reasons: ${decision.blockedReasons.join("; ")}`);
}

export async function checkHackedProfileRecoveryReviewQueue (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext): Promise<void> {
    const inProgressKey = "hackedProfileRecoveryReviewInProgress";
    if (event.data?.firstRun && await context.redis.exists(inProgressKey)) {
        console.log("HackedProfileRecoveryReview: Job already in progress on first run, skipping execution to avoid duplicate jobs");
        return;
    }

    const queue = await context.redis.zRange(HACKED_PROFILE_RECOVERY_REVIEW_QUEUE_KEY, 0, Date.now(), { by: "score" });
    if (queue.length === 0) {
        console.log("HackedProfileRecoveryReview: No users in recovery review queue");
        return;
    }

    if (event.data?.firstRun) {
        console.log(`HackedProfileRecoveryReview: Found ${queue.length} ${pluralize("user", queue.length)} in recovery review queue on first run, starting to process`);
    }

    const username = queue.shift()?.member;
    if (!username) {
        await context.redis.del(inProgressKey);
        return;
    }

    await context.redis.set(inProgressKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });
    await context.redis.zRem(HACKED_PROFILE_RECOVERY_REVIEW_QUEUE_KEY, [username]);

    try {
        await reviewHackedProfileRecovery(username, context);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`HackedProfileRecoveryReview: Error reviewing ${username}: ${errorMessage}`);
    }

    if (queue.length > 0) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.HackedProfileRecoveryReview,
            data: { firstRun: false },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        console.log("HackedProfileRecoveryReview: Queue is empty, clearing in progress key");
        await context.redis.del(inProgressKey);
    }
}
