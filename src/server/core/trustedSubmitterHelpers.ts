import { cache } from "@devvit/web/server";
import { getControlSubSettings } from ".";
import { getSubmitterSuccessRate } from "./controlSubCore/statistics";

export async function userIsTrustedSubmitter (username: string): Promise<boolean> {
    return await cache(
        async () => {
            const controlSubSettings = await getControlSubSettings();
            if (controlSubSettings.trustedSubmitters.some(submitter => submitter.toLowerCase() === username.toLowerCase())) {
                return true;
            }

            if (controlSubSettings.trustedSubmitterAutoThreshold) {
                if (controlSubSettings.trustedSubmitterAutoExcludedUsers?.some(excludedUser => excludedUser.toLowerCase() === username.toLowerCase())) {
                    return false;
                }

                const submitterSuccessRate = await getSubmitterSuccessRate(username);
                if (submitterSuccessRate && submitterSuccessRate >= controlSubSettings.trustedSubmitterAutoThreshold) {
                    console.log(`User ${username} is a trusted submitter based on success rate of ${submitterSuccessRate}%`);
                    return true;
                }
            }

            return false;
        },
        {
            key: `userIsATrustedSubmitter:${username}`,
            ttl: 120,
        },
    );
}
