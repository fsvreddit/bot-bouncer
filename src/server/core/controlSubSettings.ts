import { context, reddit, redis, WikiPage } from "@devvit/web/server";
import { ControlSubSettings, controlSubSettingsSchema } from "@fsvreddit/bot-bouncer-types";
import { CONTROL_SUBREDDIT } from "./constants";
import { addMinutes } from "date-fns";
import json2md from "json2md";
import { sendMessageToWebhook } from "./utility";
import Ajv from "ajv";

const CONTROL_SUB_SETTINGS_WIKI_PAGE = "control-sub-settings";
const CONTROL_SUB_SETTINGS_CACHE_KEY = "controlSubSettings";

export async function getControlSubSettings (): Promise<ControlSubSettings> {
    let cachedSettings: string | undefined;
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        cachedSettings = await redis.get(CONTROL_SUB_SETTINGS_CACHE_KEY);
        if (cachedSettings) {
            return JSON.parse(cachedSettings) as ControlSubSettings;
        }
    }

    cachedSettings = await redis.global.get(CONTROL_SUB_SETTINGS_CACHE_KEY);

    if (!cachedSettings) {
        throw new Error("Control sub settings not found in global redis");
    }

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        await redis.set(CONTROL_SUB_SETTINGS_CACHE_KEY, cachedSettings, { expiration: addMinutes(new Date(), 15) });
        console.log("Control sub settings refreshed for client subreddit");
    }

    return JSON.parse(cachedSettings) as ControlSubSettings;
}

async function reportControlSubValidationError (username: string, message: string) {
    const messageBody: json2md.DataObject[] = [
        { p: `Hi ${username}, ` },
        { p: `There is an issue with the control sub settings on r/${CONTROL_SUBREDDIT}:` },
        { blockquote: message },
        { p: `Please correct this issue as soon as possible. The settings can be found [here](https://www.reddit.com/r/${CONTROL_SUBREDDIT}/wiki/control-sub-settings).` },
    ];

    await reddit.sendPrivateMessage({
        subject: "Validation error in r/BotBouncer control sub settings",
        text: json2md(messageBody),
        to: username,
    });

    const controlSubSettings = await getControlSubSettings();
    if (controlSubSettings.monitoringWebhook) {
        const discordMessageBody: json2md.DataObject[] = [
            { p: `There is an issue with the control sub settings on r/${CONTROL_SUBREDDIT} as edited by ${username}:` },
            { blockquote: message },
            { p: `Please correct this issue as soon as possible. The settings can be found [here](<https://www.reddit.com/r/${CONTROL_SUBREDDIT}/wiki/control-sub-settings>).` },
        ];
        await sendMessageToWebhook(controlSubSettings.monitoringWebhook, json2md(discordMessageBody));
    }
}

export async function validateControlSubConfigChange (username: string) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("validateControlSubConfigChange can only be called in the control subreddit");
    }

    const redisKey = "lastControlSubRevision";
    const lastRevision = await redis.get(redisKey);

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await reddit.getWikiPage(CONTROL_SUBREDDIT, CONTROL_SUB_SETTINGS_WIKI_PAGE, {});
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
        await reportControlSubValidationError(username, "Invalid JSON in control sub settings");
        return;
    }

    const ajv = new Ajv();
    const validate = ajv.compile(controlSubSettingsSchema);
    if (!validate(json)) {
        await reportControlSubValidationError(username, `Control sub settings are invalid: ${ajv.errorsText(validate.errors)}`);
        return;
    }

    await redis.set(redisKey, wikiPage.revisionId);
    await redis.global.set(CONTROL_SUB_SETTINGS_CACHE_KEY, wikiPage.content);
    console.log("Control sub settings validated successfully");
}
