import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { subYears } from "date-fns";

export class EvaluateZombieNSFW extends UserEvaluatorBase {
    override name = "Zombie NSFW Poster";
    override killswitch = "zombiensfw:killswitch";

    override banContentThreshold = 5;

    private getRegexes (): RegExp[] {
        const regexList = this.variables["zombiensfw:regexes"] as string[] | undefined ?? [];
        return regexList.map(regex => new RegExp(regex));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    private eligiblePost (post: Post) {
        const regexes = this.getRegexes();
        return post.nsfw && regexes.some(regex => regex.test(post.title));
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        const minAccountAgeInYears = this.variables["zombiensfw:minaccountage"] as number | undefined ?? 10;

        return user.createdAt < subYears(new Date(), minAccountAgeInYears);
    }

    override evaluate (_: User, history: (Post | Comment)[]): boolean {
        const posts = history.filter(item => isLinkId(item.id)) as Post[];
        const eligiblePosts = posts.filter(post => this.eligiblePost(post));

        const minPostsRequired = this.variables["zombiensfw:minposts"] as number | undefined ?? 5;
        if (eligiblePosts.length < minPostsRequired) {
            this.setReason(`User has less than ${minPostsRequired} matching NSFW posts`);
            return false;
        }

        return true;
    }
}
