import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { compact, countBy, toPairs, uniq } from "lodash";
import { subMonths } from "date-fns";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateDomainSharer extends UserEvaluatorBase {
    override name = "Domain Sharer";
    override shortname = "domainsharer";
    override canAutoBan = false;

    private domainsFromContent (content: string): string[] {
        // eslint-disable-next-line no-useless-escape
        const domainRegex = /(https?:\/\/[\w\.]+)[\/\)]/g;
        const matches = content.matchAll(domainRegex);

        const domains: (string | undefined)[] = [];

        for (const match of matches) {
            const [, url] = match;
            domains.push(domainFromUrl(url));
        }

        const redditDomains = this.getGenericVariable<string[]>("redditdomains", []);
        const ignoredDomains = this.getVariable<string[]>("ignoreddomains", []);
        return uniq(compact((domains)).filter(domain => !redditDomains.includes(domain) && !ignoredDomains.includes(domain)));
    }

    private ignoredSubreddits () {
        return this.getVariable<string[]>("ignoredsubreddits", []);
    }

    private domainsFromPost (post: Post): string[] {
        const domains: (string | undefined)[] = [];
        if (!post.url.startsWith("/")) {
            domains.push(domainFromUrl(post.url));
        }

        if (post.body) {
            domains.push(...this.domainsFromContent(post.body));
        }

        const redditDomains = this.getGenericVariable<string[]>("redditdomains", []);
        const ignoredDomains = this.getVariable<string[]>("ignoreddomains", []);
        return uniq(compact(domains).filter(domain => !redditDomains.includes(domain) && !ignoredDomains.includes(domain)));
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        if (event.subreddit?.name && this.ignoredSubreddits().includes(event.subreddit.name)) {
            return false;
        }

        return this.domainsFromContent(event.comment.body).length > 0;
    }

    override preEvaluatePost (post: Post): boolean {
        if (this.ignoredSubreddits().includes(post.subredditName)) {
            return false;
        }

        return this.domainsFromPost(post).length > 0;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        return user.commentKarma < 1000 && user.linkKarma < 1000;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const contentInAllowedSubs = history.filter(item => !this.ignoredSubreddits().includes(item.subredditName));

        if (contentInAllowedSubs.length < 5) {
            this.setReason("Not enough content to review.");
            return false;
        }

        const recentPosts = this.getPosts(contentInAllowedSubs, { since: subMonths(new Date(), 6) });
        const recentComments = this.getComments(contentInAllowedSubs, { since: subMonths(new Date(), 6) });

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

        const dominantDomains = domainAggregate.filter(item => item.count === contentInAllowedSubs.length);
        if (dominantDomains.length > 0) {
            const autobanDomains = this.getVariable<string[]>("autobandomains", []);
            if (autobanDomains.some(domain => dominantDomains.some(item => item.domain === domain))) {
                this.canAutoBan = true;
                this.banContentThreshold = 5;
            }
            this.hitReason = `User has shared ${contentInAllowedSubs.length} posts with the same domain: ${dominantDomains.map(item => item.domain).join(", ")}`;
            return true;
        } else {
            this.setReason("User content is not dominated by one domain");
            return false;
        }
    }
}
