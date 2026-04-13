import { JobContext, TriggerContext } from "@devvit/public-api";
import { AppSetting } from "../settings.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import OpenAI from "openai";

interface OpenAIQuery {
    model?: string;
    prompt: string;
    temperature?: number;
}

export async function callOpenAI (input: OpenAIQuery, context: TriggerContext | JobContext): Promise<string> {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error(`callOpenAI should only be called on subreddit ${CONTROL_SUBREDDIT}, but is being called on ${context.subredditName}`);
    }

    const apiKey = await context.settings.get<string>(AppSetting.OpenAIKey);
    if (!apiKey) {
        throw new Error("OpenAI API key is not set in app settings.");
    }

    const openAI = new OpenAI({
        apiKey,
    });

    const response = await openAI.responses.create({
        model: input.model ?? "gpt-5.4-mini",
        input: input.prompt,
        temperature: input.temperature ?? 0.7,
    });

    console.log(`OpenAI: Model used: ${response.model}`);
    if (response.usage) {
        console.log(`OpenAI: Total tokens used: ${response.usage.total_tokens}`);
    }

    if (response.status === "failed") {
        throw new Error(`OpenAI API call failed: ${response.error?.message ?? "Unknown error"}`);
    }

    return response.output_text;
}
