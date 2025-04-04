import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import { getUserOrUndefined } from "../utility.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { compact } from "lodash";

export class EvaluateLilyBot extends UserEvaluatorBase {
    override name = "Lily Bot";
    override killswitch = "lilybot:killswitch";
    override banContentThreshold = 1;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    private names = ["Lily"];
    private badSocialDomains = ["getallmylinks.com", "linktr.ee", "beacons.ai"];

    override async preEvaluateUser (user: UserExtended): Promise<boolean> {
        if (!this.names.some(name => user.displayName?.includes(name)
            && user.userDescription?.includes(name)
            && !user.username.toLowerCase().includes(name.toLowerCase()))) {
            return false;
        };

        const realUser = await getUserOrUndefined(user.username, this.context);
        if (!realUser) {
            return false;
        }

        const socialLinks = await realUser.getSocialLinks();
        const socialDomains = compact(socialLinks.map(link => domainFromUrl(link.outboundUrl)));
        return socialDomains.some(domain => this.badSocialDomains.some(badDomain => domain.includes(badDomain)));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (_user: UserExtended, _history: (Post | Comment)[]): boolean {
        return true;
    }
}
