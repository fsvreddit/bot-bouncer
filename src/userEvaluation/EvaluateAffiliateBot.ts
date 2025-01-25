import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { subYears } from "date-fns";
import { compact, uniq } from "lodash";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateAffiliateBot extends UserEvaluatorBase {
    override name = "Affiliate Bot";

    private domainsFromContent (content: string): string[] {
        // eslint-disable-next-line no-useless-escape
        const domainRegex = /(https?:\/\/[\w\.]+)[\/\)]/g;
        const matches = content.matchAll(domainRegex);

        const domains: (string | undefined)[] = [];

        for (const match of matches) {
            const [, url] = match;
            domains.push(domainFromUrl(url));
        }

        const redditDomains = this.variables["generic:redditdomains"] as string[] | undefined ?? [];
        return uniq(compact((domains)).filter(domain => !redditDomains.includes(domain)));
    }

    private eligiblePost (post: Post) {
        const redditDomains = this.variables["generic:redditdomains"] as string[] | undefined ?? [];
        const postDomain = domainFromUrl(post.url);
        return postDomain !== undefined && redditDomains.includes(postDomain);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        const domains = this.variables["affiliate:domains"] as string[] | undefined ?? [];
        const domainsInComment = this.domainsFromContent(event.comment.body);

        return domainsInComment.some(domain => domains.includes(domain));
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        if (user.commentKarma > 500) {
            this.setReason("User has too much comment karma");
            return false;
        }

        if (user.linkKarma > 10000) {
            this.setReason("User has too much link karma");
            return false;
        }

        if (user.createdAt < subYears(new Date(), 2)) {
            this.setReason("Account is too old");
            return false;
        }

        const usernameRegex = /^[A-Z]/;
        if (!usernameRegex.test(user.username)) {
            this.setReason("Username does not start with a capital letter");
            return false;
        }

        return true;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- cannot upload without this.
        const userComments = history.filter(item => item instanceof Comment) as Comment[];
        const userDomains = uniq(userComments.map(comment => this.domainsFromContent(comment.body)).flat());

        const affiliateDomains = this.variables["affiliate:domains"] as string[] | undefined ?? [];
        const userAffiliateDomains = userDomains.filter(domain => affiliateDomains.includes(domain));

        const domainCountNeeded = this.variables["affiliate:domaincount"] as number | undefined ?? 4;
        if (userAffiliateDomains.length < domainCountNeeded) {
            this.setReason("User doesn't have enough distinct affiliate domains in history");
            return false;
        }

        const commentsWithAffiliateDomains = userComments.filter(comment => this.domainsFromContent(comment.body).some(domain => affiliateDomains.includes(domain)));
        if (commentsWithAffiliateDomains.length / userComments.length < 0.5) {
            this.setReason("User doesn't have enough comments with affiliate domains");
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const userPosts = history.filter(item => item instanceof Post) as Post[];
        if (!userPosts.every(post => this.eligiblePost(post))) {
            this.setReason("User has ineligible posts");
            return false;
        }

        return true;
    }
}
