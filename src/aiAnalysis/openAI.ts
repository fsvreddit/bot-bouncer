import { JobContext, TriggerContext } from "@devvit/public-api";
import { AppSetting } from "../settings.js";
import { CONTROL_SUBREDDIT } from "../constants.js";

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

    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: input.model ?? "gpt-5.4-mini",
            input: input.prompt,
            temperature: input.temperature ?? 0.7,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error: ${err}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();

    // Extract the assistant's reply text
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return data.output[0].content[0].text;
}
