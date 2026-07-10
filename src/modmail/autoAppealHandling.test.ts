import { appealConfigNeedsUserHistory } from "./autoAppealHandling.js";

test("appeal config loads history when repeated comments are required", () => {
    expect(appealConfigNeedsUserHistory([{ hasMoreThanOneCommentOnPost: true }])).toBe(true);
});

test("appeal config loads history when repeated comments are disallowed", () => {
    expect(appealConfigNeedsUserHistory([{ hasMoreThanOneCommentOnPost: false }])).toBe(true);
});

test("appeal config skips history when no rule inspects repeated comments", () => {
    expect(appealConfigNeedsUserHistory([{}])).toBe(false);
});
