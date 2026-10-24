import { reddit, redis } from "@devvit/web/server";
import Ajv, { JSONSchemaType } from "ajv";
import { parseAllDocuments } from "yaml";
import { CONTROL_SUBREDDIT } from "../..";
import { compact } from "lodash-es";

export interface PromptData {
    model: string;
    temperature?: number;
    prompt: string;
    altPrompts?: Record<string, string>;
}

const promptSchema: JSONSchemaType<PromptData> = {
    type: "object",
    properties: {
        model: { type: "string" },
        temperature: { type: "number", nullable: true },
        prompt: { type: "string" },
        altPrompts: {
            type: "object",
            propertyNames: { type: "string" },
            additionalProperties: { type: "string" },
            nullable: true,
            required: [],
        },
    },
    required: ["model", "prompt"],
    additionalProperties: false,
};

export async function getPromptData (wikiPageName: string): Promise<PromptData> {
    const promptCacheKey = "aiPromptCache";
    const cachedPrompt = await redis.hGet(promptCacheKey, wikiPageName);
    if (cachedPrompt) {
        return JSON.parse(cachedPrompt) as PromptData;
    }

    const wikiPage = await reddit.getWikiPage(CONTROL_SUBREDDIT, wikiPageName, {});
    const content = compact(parseAllDocuments(wikiPage.content).map(doc => doc.toJSON() as PromptData));

    if (content.length === 0) {
        throw new Error("No valid prompt data found in wiki page");
    }

    const promptData = content[0];

    const ajv = new Ajv();
    const validate = ajv.compile(promptSchema);
    if (!validate(promptData)) {
        console.error("Prompt validation failed", validate.errors);
        throw new Error(`Prompt validation failed: ${ajv.errorsText(validate.errors)}`);
    }

    await redis.hSet(promptCacheKey, { [wikiPageName]: JSON.stringify(promptData) });
    return promptData;
}
