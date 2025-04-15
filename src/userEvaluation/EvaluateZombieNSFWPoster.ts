import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { subYears } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateZombieNSFW extends UserEvaluatorBase {
    override name = "Zombie NSFW Poster";
    override shortname = "zombiensfw";

    override banContentThreshold = 5;

    private getRegexes (): RegExp[] {
        const regexList = this.getVariable<string[]>("regexes", []);
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

    override preEvaluateUser (user: UserExtended): boolean {
        const minAccountAgeInYears = this.getVariable<number>("minaccountage", 10);

        return user.createdAt < subYears(new Date(), minAccountAgeInYears);
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const posts = this.getPosts(history);
        const eligiblePosts = posts.filter(post => this.eligiblePost(post));

        const minPostsRequired = this.getVariable<number>("minposts", 5);
        if (eligiblePosts.length < minPostsRequired) {
            this.setReason(`User has less than ${minPostsRequired} matching NSFW posts`);
            return false;
        }

        return true;
    }
}
