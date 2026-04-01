import { JobContext, TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { parseAllDocuments } from "yaml";
import _ from "lodash";

export interface PromptData {
    model: string;
    temperature?: number;
    prompt: string;
}

const promptSchema: JSONSchemaType<PromptData> = {
    type: "object",
    properties: {
        model: { type: "string" },
        temperature: { type: "number", nullable: true },
        prompt: { type: "string" },
    },
    required: ["model", "prompt"],
    additionalProperties: false,
};

export async function getPromptData (wikiPageName: string, context: JobContext | TriggerContext): Promise<PromptData> {
    const promptCacheKey = "modmailSummaryPrompt";
    const cachedPrompt = await context.redis.get(promptCacheKey);
    if (cachedPrompt) {
        return JSON.parse(cachedPrompt) as PromptData;
    }

    const wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, wikiPageName);
    const content = _.compact(parseAllDocuments(wikiPage.content).map(doc => doc.toJSON() as PromptData));

    if (content.length === 0) {
        throw new Error("No valid prompt data found in wiki page");
    }

    const promptData = content[0];

    const ajv = new Ajv.default();
    const validate = ajv.compile(promptSchema);
    if (!validate(promptData)) {
        console.error("Prompt validation failed", validate.errors);
        throw new Error(`Prompt validation failed: ${ajv.errorsText(validate.errors)}`);
    }

    await context.redis.set(promptCacheKey, JSON.stringify(promptData));
    return promptData;
}
