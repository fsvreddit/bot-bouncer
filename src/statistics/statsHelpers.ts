import { UserDetails, UserStatus } from "../dataStore.js";

export function userIsBanned (userDetails: UserDetails): boolean {
    if (userDetails.userStatus === UserStatus.Banned) {
        return true;
    }

    if (userDetails.userStatus === UserStatus.Purged || userDetails.userStatus === UserStatus.Retired) {
        return userDetails.lastStatus === UserStatus.Banned;
    }

    return false;
}
