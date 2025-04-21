import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import { subDays } from "date-fns";
import { CONTROL_SUBREDDIT } from "../constants.js";

export class EvaluateAdviceBot extends UserEvaluatorBase {
    override name = "Advice Bot";
    override shortname = "advice";

    public override banContentThreshold = 1;

    private isEligibleSubreddit (subreddit: string): boolean {
        const anySub = this.getVariable<boolean>("anysub", false);
        if (anySub) {
            return true;
        }

        const subList = this.getVariable<string[]>("sublist", []);
        return subreddit === CONTROL_SUBREDDIT || subList.includes(subreddit);
    }

    override evaluatorDisabled (): boolean {
        const killswitch = this.getVariable<boolean>("killswitch", false);
        if (killswitch) {
            return true;
        }

        if (!this.context.subredditName) {
            return true;
        }
        return !this.isEligibleSubreddit(this.context.subredditName);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        if (!this.context.subredditName) {
            return false;
        }
        return this.isEligibleSubreddit(this.context.subredditName) && this.postIsAIAdvicePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const maxAgeInDays = this.getVariable<number>("maxageindays", 60);
        return user.commentKarma < 100 && user.createdAt > subDays(new Date(), maxAgeInDays);
    }

    override evaluate (_user: UserExtended, history: (Post | Comment)[]): boolean {
        const posts = this.getPosts(history).filter(post => post.createdAt > subDays(new Date(), 7) && post.body && this.isEligibleSubreddit(post.subredditName));
        if (posts.length === 0) {
            this.setReason("No posts in the last 7 days");
            return false;
        }

        return posts.some(post => this.postIsAIAdvicePost(post));
    }

    private postIsAIAdvicePost (post: Post): boolean {
        if (!post.body) {
            return false;
        }

        if (post.edited) {
            this.setReason("Post is edited");
            return false;
        }

        const postBody = post.body.trim();

        const paragraphs = postBody.split("\n\n")
            .filter(paragraph => paragraph.trim() !== "")
            .map(paragraph => paragraph.trim());

        // Checks that MUST pass for the post to be considered an AI advice post
        const minParagraphs = this.getVariable<number>("minparagraphs", 1);
        if (paragraphs.length < minParagraphs) {
            this.setReason(`Post has less than ${minParagraphs} paragraphs`);
            return false;
        }

        const maxFinalParaLength = this.getVariable<number>("maxfinalparalength", 1000);
        const lastParagraph = paragraphs[paragraphs.length - 1];
        if (lastParagraph.length > maxFinalParaLength) {
            this.setReason(`Post has a final paragraph longer than ${maxFinalParaLength} characters`);
            return false;
        }

        const maxParagraphs = this.getVariable<number>("maxparagraphs", 100);
        if (paragraphs.length > maxParagraphs) {
            this.setReason(`Post has more than ${maxParagraphs} paragraphs`);
            return false;
        }

        const requiredRegexes = this.getVariable<string[]>("requiredregexes", []);
        if (requiredRegexes.length === 0) {
            this.setReason("No required regexes set");
            return false;
        }

        const missedRegexes = requiredRegexes.filter(regex => !new RegExp(regex, "u").test(postBody));
        if (missedRegexes.length > 0) {
            this.setReason(`Post does not match required regexes: ${missedRegexes.join(", ")}`);
            return false;
        }

        const disallowedRegexes = this.getVariable<string[]>("disallowedregexes", []);
        const matchedDisallowedRegexes = disallowedRegexes.filter(regex => new RegExp(regex, "u").test(postBody));
        if (matchedDisallowedRegexes.length > 0) {
            this.setReason(`Post matches disallowed regexes: ${matchedDisallowedRegexes.join(", ")}`);
            return false;
        }

        const eachParaRequiredRegexes = this.getVariable<string[]>("eachpararequiredregexes", []);
        for (const paragraph of paragraphs) {
            const missedEachParaRequiredRegexes = eachParaRequiredRegexes.filter(regex => !new RegExp(regex, "u").test(paragraph));
            for (const missedRegex of missedEachParaRequiredRegexes) {
                this.setReason(`Post does not match required regexes in paragraph: ${new RegExp(missedRegex, "u")}: ${paragraph}`);
            }
            if (missedEachParaRequiredRegexes.length > 0) {
                return false;
            }
        }

        let score = 0;

        // Intensifiers
        const intensifierRegexes = this.getVariable<string[]>("intensifierregexes", []);
        score += intensifierRegexes.filter(regex => new RegExp(regex, "u").test(postBody)).length;

        const paragraphintensifierregexes = this.getVariable<string[]>("paragraphintensifierregexes", []);
        for (const paragraph of paragraphs) {
            const matchedParagraphIntensifierRegexes = paragraphintensifierregexes.filter(regex => new RegExp(regex, "u").test(paragraph));
            score += matchedParagraphIntensifierRegexes.length;
        }

        // "Edit" claim without being edited
        if (lastParagraph.toLowerCase().startsWith("edit:")) {
            score += 2;
        }

        // Quotations
        const regex = /[“"].+["”]/g;
        for (const paragraph of paragraphs) {
            const matches = paragraph.matchAll(regex);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for (const match of matches) {
                score += 0.5;
            }
        }

        const scoreThreshold = this.getVariable<number>("scorethreshold", 1);
        if (score < scoreThreshold) {
            this.setReason(`Post has a score of ${score}, which is less than the threshold of ${scoreThreshold}`);
            return false;
        }

        this.hitReason = `Post has a score of ${score}, which is greater than the threshold of ${scoreThreshold}`;

        return true;
    }
}
