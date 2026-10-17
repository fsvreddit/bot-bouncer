import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { UserDetails } from "../..";
import { UserFlag } from "../../types";

export const FLAGS_TO_EXCLUDE_FROM_STATS: UserFlag[] = [
    UserFlag.HackedAndRecovered,
];
export interface StatsUserEntry {
    username: string;
    data: UserDetails;
}

export function userIsBanned (userDetails: UserDetails): boolean {
    if (userDetails.userStatus === UserStatus.Banned) {
        return true;
    }

    if (userDetails.userStatus === UserStatus.Purged || userDetails.userStatus === UserStatus.Retired) {
        return userDetails.lastStatus === UserStatus.Banned;
    }

    return false;
}
