import { SettingsFormField, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "./constants.js";
import Ajv, { JSONSchemaType } from "ajv";
import { addHours } from "date-fns";
import json2md from "json2md";

export const CONFIGURATION_DEFAULTS = {
    banMessage: `Bots and bot-like accounts are not welcome on /r/{subreddit}.

[I am a bot, and this action was performed automatically](/r/${CONTROL_SUBREDDIT}/wiki/index).
If you wish to appeal the classification of the /u/{account} account, please
[message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit})
rather than replying to this message.`,

    banNote: "Banned by /u/{me} at {date}",

    noteClient: `/u/{account} is [listed on /r/${CONTROL_SUBREDDIT}]({link}).

If this account is claiming to be human and isn't an obvious novelty account,
we recommend asking the account owner to [message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit}).

If this account is a bot that you wish to allow, remember to [allowlist](/r/${CONTROL_SUBREDDIT}/wiki/index) it before you unban it.`,

    appealMessage: `Your classification appeal has been received and will be reviewed by a
moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.

If Bot Bouncer has banned you from more than one subreddit, you don't need to appeal separately.

*This is an automated message.*`,

    appealShadowbannedMessage: `Your classification appeal has been received. Unfortunately, it is not possible to review your request at this time because you have been shadowbanned by Reddit Admin, which prevents us from reviewing your account contents.

You may appeal your shadowban by contacting the Reddit Admins [here](https://reddit.com/appeal). If you are able to get your shadowban lifted, please contact us again and we will be happy to review your classification status.

*This is an automated message.*`,

    recentAppealMade: `We have already received an appeal from you. There is no need to appeal for every subreddit that Bot Bouncer has banned you from.

Your initial appeal will be reviewed shortly by a moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.

*This is an automated message.*`,

};

export enum AppSetting {
    Action = "action",
    BanMessage = "banMessage",
    AutoWhitelist = "autoWhitelist",
    ModmailNote = "clientModmailNote",
    RemoveRecentContent = "removeRecentContent",
    ReportPotentialBots = "reportPotentialBots",
    RemoveContentWhenReporting = "removeContentWhenReporting",
    DailyDigest = "dailyDigest",
    DailyDigestIncludeReported = "dailyDigestIncludeReported",
    DailyDigestIncludeBanned = "dailyDigestIncludeBanned",
    DailyDigestIncludeUnbanned = "dailyDigestIncludeUnbanned",
    UpgradeNotifier = "upgradeNotifier",
}

export enum ActionType {
    Ban = "ban",
    Report = "report",
}

export const appSettings: SettingsFormField[] = [
    {
        type: "group",
        label: "Ban/Report and unban settings",
        fields: [
            {
                type: "select",
                name: AppSetting.Action,
                label: "Action to take when a banned account posts or comments",
                helpText: "This action applies to accounts that are listed on /r/BotBouncer as a bot",
                options: [
                    { label: "Ban", value: ActionType.Ban },
                    { label: "Report content", value: ActionType.Report },
                ],
                multiSelect: false,
                defaultValue: [ActionType.Ban],
                onValidate: ({ value }) => {
                    if (!value || value.length === 0) {
                        return "You must select an action.";
                    }
                },
            },
            {
                type: "paragraph",
                name: AppSetting.BanMessage,
                lineHeight: 10,
                label: "Ban message to use when banning user",
                helpText: "Supports placeholders {account}, {subreddit}",
                defaultValue: CONFIGURATION_DEFAULTS.banMessage,
            },
            {
                type: "boolean",
                name: AppSetting.AutoWhitelist,
                label: "Automatically exempt users banned by Bot Bouncer if they are then unbanned by you",
                helpText: "If this is selected, and you unban a user that has been banned by Bot Bouncer, then the app will not act on that user again.",
                defaultValue: true,
            },
            {
                type: "paragraph",
                name: AppSetting.ModmailNote,
                lineHeight: 10,
                label: "Template for private moderator note that will be added if banned users write in",
                helpText: `Supports placeholders {account}, {subreddit} and {link} (which links to the submission on /r/${CONTROL_SUBREDDIT})`,
                defaultValue: CONFIGURATION_DEFAULTS.noteClient,
            },
            {
                type: "boolean",
                name: AppSetting.RemoveRecentContent,
                label: "Ban newly classified accounts if they have recent interactions on your sub, and remove the last week's posts and comments",
                helpText: "If this is turned off, accounts banned on r/BotBouncer will only be actioned if they comment or post in the future.",
                defaultValue: true,
            },
        ],
    },
    {
        type: "group",
        label: "Local bot detection",
        helpText: "Options relating to detecting and reporting bots on your subreddit",
        fields: [
            {
                type: "boolean",
                name: AppSetting.ReportPotentialBots,
                label: "Report potential bots to /r/BotBouncer",
                helpText: "Automatically reports newly detected bots to /r/BotBouncer",
                defaultValue: true,
            },
            {
                type: "boolean",
                name: AppSetting.RemoveContentWhenReporting,
                label: "Remove content when potential bots are detected before classification",
                helpText: "If this is turned on, the bot will remove the content before reporting it. The comment will be approved if the user is classified human unless it was filtered or removed by AutoMod or Reddit.",
                defaultValue: false,
            },
        ],
    },
    {
        type: "group",
        label: "Daily Digest",
        fields: [
            {
                type: "boolean",
                label: "Send a daily digest of actions taken by Bot Bouncer, if any occur",
                name: AppSetting.DailyDigest,
                helpText: "If enabled, you will receive a daily message with a summary of actions taken by Bot Bouncer in the previous 24 hours, if any.",
                defaultValue: false,
            },
            {
                type: "boolean",
                label: "Include details of accounts reported to Bot Bouncer",
                name: AppSetting.DailyDigestIncludeReported,
                defaultValue: true,
            },
            {
                type: "boolean",
                label: "Include details of accounts banned by Bot Bouncer",
                name: AppSetting.DailyDigestIncludeBanned,
                defaultValue: true,
            },
            {
                type: "boolean",
                label: "Include defails of accounts unbanned by Bot Bouncer",
                name: AppSetting.DailyDigestIncludeUnbanned,
                defaultValue: true,
            },
        ],
    },
    {
        type: "group",
        label: "Upgrade Notifications",
        helpText: "Options for receiving notifications from Bot Bouncer",
        fields: [
            {
                type: "boolean",
                label: "Upgrade notifications",
                name: AppSetting.UpgradeNotifier,
                helpText: "Receive a message when a new version of Bot Bouncer is released",
                defaultValue: false,
            },
        ],
    },
];

export interface ControlSubSettings {
    evaluationDisabled: boolean;
    proactiveEvaluationEnabled?: boolean;
    maxInactivityMonths?: number;
    trustedSubmitters: string[];
    reporterBlacklist: string[];
    numberOfWikiPages?: number;
    bulkSubmitters?: string[];
    cleanupDisabled?: boolean;
    uptimeMonitoringEnabled?: boolean;
    messageMonitoringEnabled?: boolean;
    monitoringWebhook?: string;
    banNoteCheckingEnabled?: boolean;
    observerSubreddits?: string[];
    postCreationQueueProcessingEnabled?: boolean;
}

const CONTROL_SUB_SETTINGS_WIKI_PAGE = "control-sub-settings";
const OLD_CONTROL_SUB_SETTINGS_WIKI_PAGE = "controlsubsettings";

const schema: JSONSchemaType<ControlSubSettings> = {
    type: "object",
    properties: {
        evaluationDisabled: { type: "boolean" },
        proactiveEvaluationEnabled: { type: "boolean", nullable: true },
        maxInactivityMonths: { type: "number", nullable: true },
        trustedSubmitters: { type: "array", items: { type: "string" } },
        reporterBlacklist: { type: "array", items: { type: "string" } },
        numberOfWikiPages: { type: "number", nullable: true },
        bulkSubmitters: { type: "array", items: { type: "string" }, nullable: true },
        cleanupDisabled: { type: "boolean", nullable: true },
        uptimeMonitoringEnabled: { type: "boolean", nullable: true },
        messageMonitoringEnabled: { type: "boolean", nullable: true },
        monitoringWebhook: { type: "string", nullable: true },
        banNoteCheckingEnabled: { type: "boolean", nullable: true },
        observerSubreddits: { type: "array", items: { type: "string" }, nullable: true },
        postCreationQueueProcessingEnabled: { type: "boolean", nullable: true },
    },
    required: ["evaluationDisabled", "trustedSubmitters", "reporterBlacklist"],
};

export async function getControlSubSettings (context: TriggerContext): Promise<ControlSubSettings> {
    const redisKey = "controlSubSettings";
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        const cachedSettings = await context.redis.get(redisKey);
        if (cachedSettings) {
            return JSON.parse(cachedSettings) as ControlSubSettings;
        }
    }

    const defaultConfig: ControlSubSettings = {
        evaluationDisabled: false,
        proactiveEvaluationEnabled: true,
        maxInactivityMonths: 3,
        trustedSubmitters: [],
        reporterBlacklist: [],
        numberOfWikiPages: 1,
    };

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, CONTROL_SUB_SETTINGS_WIKI_PAGE);
    } catch {
        //
    }

    if (wikiPage) {
        const ajv = new Ajv.default();
        const validate = ajv.compile(schema);

        let json: ControlSubSettings | undefined;
        try {
            json = JSON.parse(wikiPage.content) as ControlSubSettings;
        } catch (error) {
            console.error("Control sub settings are invalid. Default values will be returned.", error);
            return defaultConfig;
        }

        if (!validate(json)) {
            console.error("Control sub settings are invalid. Default values will be returned.", ajv.errorsText(validate.errors));
            return defaultConfig;
        } else {
            if (context.subredditName !== CONTROL_SUBREDDIT) {
                await context.redis.set(redisKey, wikiPage.content, { expiration: addHours(new Date(), 1) });
            }
            return JSON.parse(wikiPage.content) as ControlSubSettings;
        }
    }

    return defaultConfig;
}

async function reportControlSubValidationError (username: string, message: string, context: TriggerContext) {
    const messageBody: json2md.DataObject[] = [
        { p: `Hi ${username}, ` },
        { p: `There is an issue with the control sub settings on r/${CONTROL_SUBREDDIT}:` },
        { blockquote: message },
        { p: `Please correct this issue as soon as possible. The settings can be found [here](https://www.reddit.com/r/BotBouncer/wiki/controlsubsettings).` },
    ];

    await context.reddit.sendPrivateMessage({
        subject: "Validation error in r/BotBouncer control sub settings",
        text: json2md(messageBody),
        to: username,
    });
}

export async function validateControlSubConfigChange (username: string, context: TriggerContext) {
    const redisKey = "lastControlSubRevision";
    const lastRevision = await context.redis.get(redisKey);

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, CONTROL_SUB_SETTINGS_WIKI_PAGE);
    } catch {
        //
    }

    if (!wikiPage || wikiPage.revisionId === lastRevision) {
        return;
    }

    let json: ControlSubSettings | undefined;
    try {
        json = JSON.parse(wikiPage.content) as ControlSubSettings;
    } catch {
        await reportControlSubValidationError(username, "Invalid JSON in control sub settings", context);
        return;
    }

    const ajv = new Ajv.default();
    const validate = ajv.compile(schema);
    if (!validate(json)) {
        await reportControlSubValidationError(username, `Control sub settings are invalid: ${ajv.errorsText(validate.errors)}`, context);
        return;
    }

    await context.redis.set(redisKey, wikiPage.revisionId);
    console.log("Control sub settings validated successfully");

    await context.scheduler.runJob({
        name: ControlSubredditJob.CopyControlSubSettings,
        runAt: new Date(),
    });
}

export async function copyControlSubSettingsToOldWiki (_: unknown, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, CONTROL_SUB_SETTINGS_WIKI_PAGE);
    } catch {
        console.error("Failed to get control sub settings wiki page");
        return;
    }

    let oldWikiPage: WikiPage;
    try {
        oldWikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, OLD_CONTROL_SUB_SETTINGS_WIKI_PAGE);
    } catch {
        console.error("Failed to get old control sub settings wiki page");
        return;
    }

    if (oldWikiPage.content.trim() === wikiPage.content.trim()) {
        console.log("Control sub settings wiki page is already up to date");
        return;
    }

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: OLD_CONTROL_SUB_SETTINGS_WIKI_PAGE,
        content: wikiPage.content,
        reason: "Updating overwritten control sub settings wiki page",
    });

    await context.reddit.updateWikiPageSettings({
        subredditName: CONTROL_SUBREDDIT,
        page: OLD_CONTROL_SUB_SETTINGS_WIKI_PAGE,
        listed: false,
        permLevel: WikiPagePermissionLevel.MODS_ONLY,
    });

    console.log("Control sub settings wiki page copied to old wiki page");
}
