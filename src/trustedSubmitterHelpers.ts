import { TriggerContext } from "@devvit/public-api";
import { getControlSubSettings } from "./settings.js";
import { getSubmitterSuccessRate } from "./statistics/submitterStatistics.js";

export async function userIsTrustedSubmitter (username: string, context: TriggerContext): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.trustedSubmitters.some(submitter => submitter.toLowerCase() === username.toLowerCase())) {
        return true;
    }

    if (controlSubSettings.trustedSubmitterAutoThreshold) {
        if (controlSubSettings.trustedSubmitterAutoExcludedUsers?.some(excludedUser => excludedUser.toLowerCase() === username.toLowerCase())) {
            return false;
        }

        const submitterSuccessRate = await getSubmitterSuccessRate(username, context);
        if (submitterSuccessRate && submitterSuccessRate >= controlSubSettings.trustedSubmitterAutoThreshold) {
            console.log(`User ${username} is a trusted submitter based on success rate of ${submitterSuccessRate}%`);
            return true;
        }
    }

    return false;
}
