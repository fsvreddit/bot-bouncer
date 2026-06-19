import { Context, JobContext, TriggerContext } from "@devvit/public-api";
import { addHours, addMinutes, subMinutes } from "date-fns";
import _ from "lodash";
import { ALL_RELEVANT_EVALUTORS, CONTROL_SUBREDDIT } from "./constants.js";

const CONFIG_REVISION_RECEIPTS_KEY = "configRevisionReceipts";
const CONFIG_REVISION_RECENT_KEY = "configRevisionRecent";
const CONFIG_REVISION_USER_HIT_PREFIX = "configRevisionUserHit";
export const CURRENT_CONFIG_REVISION_CODE_KEY = "configRevisionCurrentCode";

const SHARED_VARIABLE_PREFIXES = ["generic", "substitutions"];

export interface ConfigRevisionReceipt {
    code: string;
    createdAt: number;
    updatedBy?: string;
    changedVariableKeys: string[];
    changedEvaluatorShortnames: string[];
    changedEvaluatorNames: string[];
    appliesToAllEvaluators: boolean;
}

export interface ConfigRevisionUserHit {
    username: string;
    revisionCode: string;
    evaluatorShortname: string;
    evaluatorName: string;
    caughtAt: number;
    targetId?: string;
    subreddit?: string;
}

export interface ConfigRevisionUserHitWithReceipt {
    hit: ConfigRevisionUserHit;
    receipt: ConfigRevisionReceipt;
}

function getVariablePrefix (variableKey: string): string {
    return variableKey.split(":")[0] ?? variableKey;
}

function getEvaluatorNamesByShortname (): Record<string, string> {
    return _.fromPairs(ALL_RELEVANT_EVALUTORS.map((Evaluator) => {
        const evaluator = new Evaluator({} as unknown as TriggerContext, [], undefined, {});
        return [evaluator.shortname, evaluator.name];
    }));
}

function randomCodeSuffix (): string {
    const characters = "abcdefghjkmnpqrstuvwxyz23456789";
    let suffix = "";
    for (let i = 0; i < 5; i++) {
        suffix += characters[Math.floor(Math.random() * characters.length)];
    }
    return suffix;
}

function buildRevisionCode (createdAt: Date): string {
    const timestamp = createdAt.toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/:/g, "-");
    return `${timestamp}-${randomCodeSuffix()}`;
}

function receiptAppliesToEvaluator (receipt: ConfigRevisionReceipt, evaluatorShortname: string): boolean {
    return receipt.appliesToAllEvaluators || receipt.changedEvaluatorShortnames.includes(evaluatorShortname);
}

export async function getConfigRevisionReceipt (code: string, context: Context | TriggerContext | JobContext): Promise<ConfigRevisionReceipt | undefined> {
    const receiptRaw = await context.redis.global.hGet(CONFIG_REVISION_RECEIPTS_KEY, code);
    if (!receiptRaw) {
        return;
    }

    return JSON.parse(receiptRaw) as ConfigRevisionReceipt;
}

function getConfigRevisionUserHitKey (username: string): string {
    return `${CONFIG_REVISION_USER_HIT_PREFIX}:${username}`;
}

async function cleanupOldConfigRevisionReceipts (context: JobContext | TriggerContext) {
    const staleEntries = await context.redis.global.zRange(CONFIG_REVISION_RECENT_KEY, 0, subMinutes(new Date(), 60 * 24).getTime(), { by: "score" });
    const staleCodes = staleEntries.map(entry => entry.member);
    if (staleCodes.length === 0) {
        return;
    }

    await context.redis.global.zRem(CONFIG_REVISION_RECENT_KEY, staleCodes);
    await context.redis.global.hDel(CONFIG_REVISION_RECEIPTS_KEY, staleCodes);
}

export function getChangedVariableKeys (existingVariables: Record<string, string>, nextVariables: Record<string, string>): string[] {
    const allKeys = _.uniq([...Object.keys(existingVariables), ...Object.keys(nextVariables)]);
    return allKeys.filter(key => existingVariables[key] !== nextVariables[key]).sort();
}

export async function cacheCurrentConfigRevisionCodeLocally (context: TriggerContext | JobContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const revisionCode = await context.redis.global.get(CURRENT_CONFIG_REVISION_CODE_KEY);
    if (!revisionCode) {
        return;
    }

    await context.redis.set(CURRENT_CONFIG_REVISION_CODE_KEY, revisionCode, { expiration: addMinutes(new Date(), 5) });
}

export async function recordEvaluatorConfigRevisionReceipt (options: {
    updatedBy?: string;
    changedVariableKeys: string[];
}, context: JobContext | TriggerContext): Promise<ConfigRevisionReceipt | undefined> {
    if (options.changedVariableKeys.length === 0) {
        return;
    }

    const createdAt = new Date();
    const code = buildRevisionCode(createdAt);
    const evaluatorNamesByShortname = getEvaluatorNamesByShortname();
    const changedPrefixes = _.uniq(options.changedVariableKeys.map(getVariablePrefix));
    const appliesToAllEvaluators = changedPrefixes.some(prefix => SHARED_VARIABLE_PREFIXES.includes(prefix));
    const changedEvaluatorShortnames = changedPrefixes.filter(prefix => evaluatorNamesByShortname[prefix]).sort();
    const changedEvaluatorNames = changedEvaluatorShortnames.map(shortname => evaluatorNamesByShortname[shortname]).sort();

    const receipt: ConfigRevisionReceipt = {
        code,
        createdAt: createdAt.getTime(),
        updatedBy: options.updatedBy,
        changedVariableKeys: options.changedVariableKeys,
        changedEvaluatorShortnames,
        changedEvaluatorNames,
        appliesToAllEvaluators,
    };

    await context.redis.global.hSet(CONFIG_REVISION_RECEIPTS_KEY, { [code]: JSON.stringify(receipt) });
    await context.redis.global.zAdd(CONFIG_REVISION_RECENT_KEY, { member: code, score: receipt.createdAt });
    await context.redis.global.set(CURRENT_CONFIG_REVISION_CODE_KEY, code);
    await cleanupOldConfigRevisionReceipts(context);

    return receipt;
}

export async function getLoadedConfigRevisionReceiptForEvaluator (evaluatorShortname: string, context: Context | TriggerContext | JobContext, withinMinutes = 60): Promise<ConfigRevisionReceipt | undefined> {
    const loadedRevisionCode = context.subredditName === CONTROL_SUBREDDIT
        ? await context.redis.global.get(CURRENT_CONFIG_REVISION_CODE_KEY)
        : await context.redis.get(CURRENT_CONFIG_REVISION_CODE_KEY);

    if (!loadedRevisionCode) {
        return;
    }

    const receipt = await getConfigRevisionReceipt(loadedRevisionCode, context);
    if (!receipt) {
        return;
    }

    const cutoff = subMinutes(new Date(), withinMinutes).getTime();
    if (receipt.createdAt < cutoff) {
        return;
    }

    if (!receiptAppliesToEvaluator(receipt, evaluatorShortname)) {
        return;
    }

    return receipt;
}

export async function recordConfigRevisionUserHit (hit: ConfigRevisionUserHit, context: Context | TriggerContext | JobContext) {
    await context.redis.global.set(getConfigRevisionUserHitKey(hit.username), JSON.stringify(hit), { expiration: addHours(new Date(), 2) });
}

export async function getRecentConfigRevisionUserHit (username: string, context: Context | TriggerContext | JobContext, withinMinutes = 60): Promise<ConfigRevisionUserHitWithReceipt | undefined> {
    const hitRaw = await context.redis.global.get(getConfigRevisionUserHitKey(username));
    if (!hitRaw) {
        return;
    }

    const hit = JSON.parse(hitRaw) as ConfigRevisionUserHit;
    const receipt = await getConfigRevisionReceipt(hit.revisionCode, context);
    if (!receipt) {
        return;
    }

    const cutoff = subMinutes(new Date(), withinMinutes).getTime();
    if (hit.caughtAt < cutoff || receipt.createdAt < cutoff) {
        return;
    }

    return { hit, receipt };
}
