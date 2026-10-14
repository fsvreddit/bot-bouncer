import { redis } from "@devvit/web/server";
import { addDays, addMinutes } from "date-fns";

function getAlreadyReportedKey (username: string): string {
    return `userAlreadyReported:${username}`;
}

export async function getAlreadyReported (username: string): Promise<boolean> {
    if (await redis.exists(getAlreadyReportedKey(username))) {
        return true;
    }
    return false;
}

export async function setAlreadyReported (username: string) {
    await redis.set(getAlreadyReportedKey(username), "", { expiration: addMinutes(new Date(), 10) });
}

function getUserFeedbackPreferenceKey (username: string): string {
    return `userFeedbackPreference:${username}`;
}

export async function getUserFeedbackPreference (username: string): Promise<boolean> {
    const value = await redis.get(getUserFeedbackPreferenceKey(username));
    return value === "true";
}

export async function setUserFeedbackPreference (username: string, preference: boolean) {
    await redis.set(getUserFeedbackPreferenceKey(username), JSON.stringify(preference), { expiration: addDays(new Date(), 28) });
}
