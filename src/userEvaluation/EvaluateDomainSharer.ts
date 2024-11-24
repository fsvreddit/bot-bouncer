import { Comment, Post, User } from "@devvit/public-api";
import { CommentSubmit } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { compact, countBy, toPairs, uniq } from "lodash";
import { subMonths } from "date-fns";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateDomainSharer extends UserEvaluatorBase {
    getName () {
        return "Domain Sharer";
    };

    private domainsFromContent (content: string): string[] {
        // eslint-disable-next-line no-useless-escape
        const domainRegex = /(https?:\/\/[\w\.]+)[\/\)]/g;
        const matches = content.matchAll(domainRegex);

        const domains: (string | undefined)[] = [];

        for (const match of matches) {
            const [, url] = match;
            domains.push(domainFromUrl(url));
        }

        return uniq(compact((domains)));
    }

    private domainsFromPost (post: Post): string[] {
        const domains: (string | undefined)[] = [];
        if (!post.url.startsWith("/")) {
            domains.push(domainFromUrl(post.url));
        }

        if (post.body) {
            domains.push(...this.domainsFromContent(post.body));
        }

        return uniq(compact(domains));
    }

    override preEvaluateComment (event: CommentSubmit): boolean {
        if (!event.comment) {
            return false;
        }

        return this.domainsFromContent(event.comment.body).length > 0;
    }

    override preEvaluatePost (post: Post): boolean {
        return this.domainsFromPost(post).length > 0;
    }

    override preEvaluateUser (user: User): boolean {
        return user.commentKarma < 1000 && user.linkKarma < 1000;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            this.setReason("User checks don't match");
            return false;
        }

        const recentContent = history.filter(item => item.createdAt > subMonths(new Date(), 6));

        if (recentContent.length < 5) {
            this.setReason("Not enough content to review.");
            return false;
        }

        const recentPosts = recentContent.filter(item => isLinkId(item.id)) as Post[];
        const recentComments = recentContent.filter(item => isCommentId(item.id)) as Comment[];

        const domains: string[] = [];
        for (const post of recentPosts) {
            domains.push(...this.domainsFromPost(post));
        }

        for (const comment of recentComments) {
            domains.push(...this.domainsFromContent(comment.body));
        }

        if (domains.length === 0) {
            this.setReason("User has not shared domains");
            return false;
        }

        const domainAggregate = toPairs(countBy(domains)).map(([domain, count]) => ({ domain, count }));

        if (domainAggregate.some(item => item.count === recentContent.length)) {
            return true;
        } else {
            this.setReason("User content is not dominated by one domain");
            return false;
        }
    }
}
