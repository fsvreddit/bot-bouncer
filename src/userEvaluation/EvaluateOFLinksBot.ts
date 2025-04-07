import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, UserSocialLink } from "@devvit/public-api";
import { subDays } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";
import { getUserOrUndefined } from "../utility.js";

export class EvaluateOFLinksBot extends UserEvaluatorBase {
    override name = "OF Links Bot";
    override killswitch = "oflinks:killswitch";
    override banContentThreshold = 1;
    override canAutoBan = true;

    protected async getSocialLinks (username: string): Promise<UserSocialLink[]> {
        const user = await getUserOrUndefined(username, this.context);
        if (!user) {
            return [];
        }
        const socialLinks = await user.getSocialLinks();
        return socialLinks;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_event: CommentCreate): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return true;
    }

    override async preEvaluateUser (user: UserExtended): Promise<boolean> {
        if (!user.displayName) {
            return false;
        }

        const usernameRegex = /[A-Z][a-z]+/;
        if (!usernameRegex.test(user.displayName)) {
            return false;
        }

        const maxAgeInDays = this.variables["oflinks:maxageindays"] as number | undefined ?? 30;
        if (user.createdAt < subDays(new Date(), maxAgeInDays)) {
            return false;
        }

        if (!user.userDescription?.includes(user.displayName)) {
            return false;
        }

        const regexes = (this.variables["oflinks:regexprefixes"] as string[] | undefined ?? [])
            .map(prefix => `^${prefix}${user.displayName?.toLowerCase()}`);

        if (regexes.length === 0) {
            return false;
        }

        const socialLinks = await this.getSocialLinks(user.username);
        console.log("Social Links", socialLinks);
        const matchedRegex = regexes.find(regex => socialLinks.some(link => new RegExp(regex, "i").test(link.outboundUrl)));
        if (!matchedRegex) {
            return false;
        }

        this.hitReason = `User has OF links in their profile: ${matchedRegex}`;
        return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (_user: UserExtended, _history: (Post | Comment)[]): boolean {
        return true;
    }
}
