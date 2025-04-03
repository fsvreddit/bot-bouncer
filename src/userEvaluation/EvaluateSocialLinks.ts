import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateSocialLinks extends UserEvaluatorBase {
    override name = "Social Links Bot";
    override killswitch = "sociallinks:killswitch";

    override banContentThreshold = 1;

    private getDomains (): string[] {
        const postDomains = this.variables["generic:redditdomains"] as string[] | undefined ?? [];
        postDomains.push("redgifs.com", "instagram.com");
        return postDomains;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        const postDomain = domainFromUrl(post.url);

        return postDomain !== undefined && (this.getDomains().includes(postDomain));
    }

    override async preEvaluateUser (user: UserExtended): Promise<boolean> {
        const badSocialLinks = this.variables["sociallinks:badlinks"] as string[] | undefined ?? [];
        if (badSocialLinks.length === 0) {
            return false;
        }

        if (user.commentKarma > 50 || user.createdAt < subMonths(new Date(), 1)) {
            return false;
        }

        let userObject: User | undefined;
        try {
            userObject = await this.context.reddit.getUserByUsername(user.username);
        } catch {
            return false;
        }

        const userSocialLinks = await userObject?.getSocialLinks();
        if (!userSocialLinks || userSocialLinks.length === 0) {
            return false;
        }

        return userSocialLinks.some(link => badSocialLinks.includes(link.outboundUrl));
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const userComments = history.filter(item => isCommentId(item.id));
        if (userComments.length > 0) {
            return false;
        }

        const recentPosts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        for (const post of recentPosts) {
            const postDomain = domainFromUrl(post.url);
            if (postDomain && !this.getDomains().includes(postDomain)) {
                this.setReason(`Post domain ${postDomain} is not in the allowed list`);
                return false;
            }
        }

        return true;
    }
}
