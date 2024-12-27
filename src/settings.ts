import { SettingsFormField, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";
import Ajv, { JSONSchemaType } from "ajv";

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

If this account is a bot that you wish to allow, remember to [whitelist](/r/${CONTROL_SUBREDDIT}/wiki/index) it before you unban it.`,

    appealMessage: `Your classification appeal has been received and will be reviewed by a
moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.

*This is an automated message.*`,

    appealShadowbannedMessage: `Your classification appeal has been received. Unfortunately, it is not possible to review your request at this time because you have been shadowbanned by Reddit Admin, which prevents us from reviewing your account contents.

You may appeal your shadowban by contacting the Reddit Admins [here](https://reddit.com/appeal). If you are able to get your shadowban lifted, please contact us again and we will be happy to review your classification status.

*This is an automated message.*`,
};

export enum AppSetting {
    BanMessage = "banMessage",
    AutoWhitelist = "autoWhitelist",
    ModmailNote = "clientModmailNote",
    RemoveRecentContent = "removeRecentContent",
    ReportPotentialBots = "reportPotentialBots",
}

export const appSettings: SettingsFormField[] = [
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
        label: "Automatically whitelist users banned by Bot Bouncer if they are then unbanned by you",
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
    {
        type: "boolean",
        name: AppSetting.ReportPotentialBots,
        label: "Report potential bots to /r/BotBouncer",
        helpText: "Automatically reports newly detected bots to /r/BotBouncer",
        defaultValue: true,
    },
];

interface ControlSubSettings {
    evaluationDisabled: boolean;
    maxInactivityMonths?: number;
    trustedSubmitters: string[];
    reporterBlacklist: string[];
}

const schema: JSONSchemaType<ControlSubSettings> = {
    type: "object",
    properties: {
        evaluationDisabled: { type: "boolean" },
        maxInactivityMonths: { type: "number", nullable: true },
        trustedSubmitters: { type: "array", items: { type: "string" } },
        reporterBlacklist: { type: "array", items: { type: "string" } },
    },
    required: ["evaluationDisabled", "trustedSubmitters", "reporterBlacklist"],
};

export async function getControlSubSettings (context: TriggerContext): Promise<ControlSubSettings> {
    const wikiPageName = "controlsubsettings";
    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, wikiPageName);
    } catch {
        //
    }

    if (wikiPage) {
        const ajv = new Ajv.default();
        const validate = ajv.compile(schema);
        const json = JSON.parse(wikiPage.content) as ControlSubSettings;

        if (!validate(json)) {
            console.error("Control sub settings are invalid. Default values will be returned.", ajv.errorsText(validate.errors));
        } else {
            return JSON.parse(wikiPage.content) as ControlSubSettings;
        }
    }

    const result: ControlSubSettings = {
        evaluationDisabled: false,
        maxInactivityMonths: 3,
        trustedSubmitters: [],
        reporterBlacklist: [],
    };

    await context.reddit.createWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: wikiPageName,
        content: JSON.stringify(result),
    });

    await context.reddit.updateWikiPageSettings({
        subredditName: CONTROL_SUBREDDIT,
        page: wikiPageName,
        listed: true,
        permLevel: WikiPagePermissionLevel.MODS_ONLY,
    });

    return result;
}

async function reportControlSubValidationError (username: string, message: string, context: TriggerContext) {
    let messageBody = `Hi ${username},\n\nThere is an issue with the control sub settings on r/${CONTROL_SUBREDDIT}:\n\n> ${message}\n\n`;
    messageBody += "Please correct this issue as soon as possible. The settings can be found [here](https://www.reddit.com/r/BotBouncer/wiki/controlsubsettings).\n\n";

    await context.reddit.sendPrivateMessage({
        subject: "Validation error in r/BotBouncer control sub settings",
        text: messageBody,
        to: username,
    });
}

export async function validateControlSubConfigChange (username: string, context: TriggerContext) {
    const redisKey = "lastControlSubRevision";
    const lastRevision = await context.redis.get(redisKey);

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, "controlsubsettings");
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
    }

    if (json) {
        const ajv = new Ajv.default();
        const validate = ajv.compile(schema);
        if (!validate(json)) {
            await reportControlSubValidationError(username, `Control sub settings are invalid: ${ajv.errorsText(validate.errors)}`, context);
        }
    }

    await context.redis.set(redisKey, wikiPage.revisionId);
}
