import { JobContext } from "@devvit/public-api";
import { AppSetting, getControlSubSettings } from "../settings.js";
import { format, startOfDay, subDays } from "date-fns";
import { sendMessageToWebhook } from "../utility.js";

interface OpenAIUsageResponse {
    object: string;
    data: {
        object: string;
        end_time: number;
        end_time_iso: string;
        results: {
            object: string;
            project_id: string | null;
            num_model_requests: number;
            user_id: string | null;
            api_key_id: string | null;
            model: string | null;
            batch: string | null;
            service_tier: string | null;
            input_tokens: number;
            output_tokens: number;
            input_cached_tokens: number;
            input_uncached_tokens: number;
            input_text_tokens: number;
            output_text_tokens: number;
            input_cached_text_tokens: number;
            input_audio_tokens: number;
            input_cached_audio_tokens: number;
            output_audio_tokens: number;
            input_image_tokens: number;
            input_cached_image_tokens: number;
            output_image_tokens: number;
        }[];
        start_time: number;
        start_time_iso: string;
    }[];
    has_more: boolean;
    next_page: string | null;
}

function formatNumber (num: number): string {
    if (num >= 1_000_000_000) {
        return `${(num / 1_000_000_000).toFixed(2)}B`;
    } else if (num >= 1_000_000) {
        return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
        return `${(num / 1_000).toFixed(2)}K`;
    } else {
        return num.toString();
    }
}

export async function gatherTokenStatistics (context: JobContext) {
    const messageLastSentKey = "openAIUsageMessageLastSent";
    const lastSent = await context.redis.get(messageLastSentKey);
    if (lastSent === format(new Date(), "yyyy-MM-dd")) {
        return;
    }

    const settings = await context.settings.getAll();
    const apiKey = settings[AppSetting.OpenAIAdminKey] as string | undefined;

    if (!apiKey) {
        console.error("OpenAI Stats: Admin API key not set. Skipping token statistics gathering.");
        return;
    }

    const projectId = settings[AppSetting.OpenAIProjectId] as string | undefined;

    const params = new URLSearchParams();
    params.append("start_time", (startOfDay(subDays(new Date(), 1)).getTime() / 1000).toString());
    params.append("end_time", (startOfDay(new Date()).getTime() / 1000).toString());
    if (projectId) {
        params.append("project_ids", projectId);
    }

    const response = await fetch(`https://api.openai.com/v1/organization/usage/completions?${params.toString()}`, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
    });

    const responseJson = await response.json() as OpenAIUsageResponse;

    const yesterdayUsage = responseJson.data.find(entry => entry.end_time_iso.startsWith(format(startOfDay(new Date()), "yyyy-MM-dd")));

    if (!yesterdayUsage) {
        console.error("OpenAI Stats: No usage data found for yesterday.");
        return;
    }

    const message = `OpenAI Usage for ${format(subDays(new Date(), 1), "yyyy-MM-dd")}:\n` +
        `- Total Tokens: ${formatNumber(yesterdayUsage.results.reduce((sum, result) => sum + result.input_tokens + result.output_tokens, 0))}\n` +
        `- Input Tokens: ${formatNumber(yesterdayUsage.results.reduce((sum, result) => sum + result.input_tokens, 0))}\n` +
        `- Output Tokens: ${formatNumber(yesterdayUsage.results.reduce((sum, result) => sum + result.output_tokens, 0))}\n` +
        `- Cached Tokens Saved: ${formatNumber(yesterdayUsage.results.reduce((sum, result) => sum + result.input_cached_tokens, 0))}`;

    console.log(message);

    const controlSubSettings = await getControlSubSettings(context);
    const webhookUrl = controlSubSettings.openAINotificationsWebhook;

    if (webhookUrl) {
        await sendMessageToWebhook(webhookUrl, message);
        await context.redis.set(messageLastSentKey, format(new Date(), "yyyy-MM-dd"));
    }
}
